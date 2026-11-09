import type { Queue } from 'bullmq';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { withTx } from '@obiba/db';
import { MAIL_ATTEMPTS, MAIL_QUEUE, TOPIC_QUEUE, TOPICS, accountIdFor, accountNameProblem, emailJob, enqueueEmail, originLabel, publishUserEvents, states, type EventPublisher, type Topic, type TokenSpec, type TypedEmailJob } from '@obiba/domain';
import { depositState, type OneClickClient, type OneClickStatus } from '@obiba/intents';
import {
  DEFAULT_RELAY_METHODS,
  RpcError,
  actions,
  buildSignedTx,
  checkRelayable,
  isFailure,
  provisionActions,
  signedDelegateAction,
  verifyProvisioned,
  type ExpectedCode,
  type NearRpc,
  type StorageSponsor,
  type NonceSource,
  type Signer,
} from '@obiba/near';

export interface Budget {
  take(key: string, limit: number, ttlSeconds: number): Promise<boolean>;
}

export class OutboxDispatcher {
  constructor(
    private readonly pool: Pool,
    private readonly queues: Record<string, Queue>,
    private readonly log: Logger,
  ) {}

  async dispatchBatch(limit = 100): Promise<number> {
    return withTx(this.pool, async (c) => {
      const rows = await c.query<{ id: string; topic: string; payload: unknown }>(
        'select id, topic, payload from infra.outbox where dispatched_at is null order by id limit $1 for update skip locked',
        [limit],
      );
      for (const row of rows.rows) {
        const queueName = TOPIC_QUEUE[row.topic as Topic];
        const queue = queueName ? this.queues[queueName] : undefined;
        if (!queue) {
          this.log.error({ topic: row.topic, id: row.id }, 'outbox row has unknown topic');
          continue;
        }
        const mail = queueName === MAIL_QUEUE;
        await queue.add(row.topic, row.payload, {
          jobId: `outbox-${row.id}`,
          attempts: mail ? MAIL_ATTEMPTS : 8,
          backoff: { type: 'exponential', delay: mail ? 5_000 : 2_000 },
          removeOnComplete: 1_000,
          removeOnFail: false,
        });
        await c.query('update infra.outbox set dispatched_at = now() where id = $1', [row.id]);
      }
      return rows.rowCount ?? 0;
    });
  }
}

export interface ProvisionConfig {
  factoryAccount: string;
  relayerAccount: string;
  payContract: string;
  networkId: string;
  tokens: TokenSpec[];
  guardianPublicKey: string;
  dailyLimitUsd: bigint;
  maxOpAmountUsd: bigint;
  fundingYocto: bigint;
  deviceAllowanceYocto: bigint;
  storageDepositYocto: bigint;
  code: { codeHash: Uint8Array } | { wasm: Uint8Array };
  expectedCode: ExpectedCode;
  dailyProvisionCap: number;
}

export type ProvisionOutcome = 'provisioned' | 'already_active' | 'skipped' | 'quarantined' | 'over_budget';

export class Provisioner {
  constructor(
    private readonly pool: Pool,
    private readonly rpc: NearRpc,
    private readonly factory: Signer,
    private readonly relayer: Signer,
    private readonly nonces: NonceSource,
    private readonly budget: Budget,
    private readonly cfg: ProvisionConfig,
    private readonly log: Logger,
  ) {}

  async provision(uid: string): Promise<ProvisionOutcome> {
    const t = (await this.pool.query('select * from ops.provisioning_target($1)', [uid])).rows[0];
    if (!t || t.status !== 'active' || !t.pilot_allowed || !t.device_key) return 'skipped';
    if (t.account_status === 'active') return 'already_active';
    if (t.account_status === 'quarantined') return 'quarantined';
    let accountId: string = t.account_id;
    if (!accountId) {
      if (!t.account_name || accountNameProblem(t.account_name, this.cfg.factoryAccount) !== null) return 'skipped';
      const day = new Date().toISOString().slice(0, 10);
      if (!(await this.budget.take(`prov:${day}`, this.cfg.dailyProvisionCap, 172_800))) return 'over_budget';
      accountId = accountIdFor(t.account_name, this.cfg.factoryAccount);
      if (await this.rpc.accountExists(accountId)) {
        await this.audit(uid, 'account.provision', accountId, 'FAILED', { reason: 'name_exists_on_chain' });
        this.log.error({ accountId }, 'chosen account name already exists on-chain');
        return 'skipped';
      }
      await this.pool.query("insert into chain.accounts(account_id, uid, status) values ($1, $2, 'provisioning')", [accountId, uid]);
    }
    if (!(await this.rpc.accountExists(accountId))) {
      const tx = await buildSignedTx(
        this.rpc,
        this.factory,
        this.nonces,
        this.cfg.factoryAccount,
        accountId,
        provisionActions({
          accountId,
          devicePublicKey: t.device_key,
          guardianPublicKey: this.cfg.guardianPublicKey,
          payContract: this.cfg.payContract,
          networkId: this.cfg.networkId,
          tokens: this.cfg.tokens.map(({ token, decimals }) => ({ token, decimals })),
          dailyLimitUsd: this.cfg.dailyLimitUsd,
          maxOpAmountUsd: this.cfg.maxOpAmountUsd,
          fundingYocto: this.cfg.fundingYocto,
          deviceAllowanceYocto: this.cfg.deviceAllowanceYocto,
          code: this.cfg.code,
        }),
      );
      const status = await this.rpc.sendTx(tx.signedBase64, 'FINAL');
      if (isFailure(status.status)) throw new Error('provisioning transaction failed');
    }
    const check = await verifyProvisioned(this.rpc, accountId, t.device_key, this.cfg.expectedCode);
    if (!check.ok) {
      await this.pool.query("update chain.accounts set status = 'quarantined' where account_id = $1", [accountId]);
      await this.audit(uid, 'account.quarantine', accountId, 'FAILED', { reason: check.reason });
      this.log.error({ accountId, reason: check.reason }, 'provisioned account failed verification');
      return 'quarantined';
    }
    for (const token of this.cfg.tokens) {
      const reg = await this.rpc.view<unknown>(token.token, 'storage_balance_of', { account_id: accountId });
      if (reg) continue;
      const tx = await buildSignedTx(this.rpc, this.relayer, this.nonces, this.cfg.relayerAccount, token.token, [
        actions.functionCall('storage_deposit', { account_id: accountId, registration_only: true }, 30_000_000_000_000n, this.cfg.storageDepositYocto),
      ]);
      const status = await this.rpc.sendTx(tx.signedBase64, 'FINAL');
      if (isFailure(status.status)) throw new Error(`storage registration failed for ${token.token}`);
    }
    await withTx(this.pool, async (c) => {
      await c.query("update chain.accounts set status = 'active' where account_id = $1", [accountId]);
      await c.query("update identity.devices set status = 'active' where uid = $1 and initial and status = 'pending'", [uid]);
    });
    await this.audit(uid, 'account.provision', accountId, 'ALLOWED', {});
    return 'provisioned';
  }

  private async audit(actor: string, action: string, target: string, outcome: string, details: Record<string, string>) {
    await this.pool.query('insert into audit.log(actor, action, target, outcome, details) values ($1, $2, $3, $4, $5)', [actor, action, target, outcome, JSON.stringify(details)]);
  }
}

export interface RelayConfig {
  relayerAccount: string;
  accountSuffix: string;
  maxGas: bigint;
  maxRelaysPerUserPerDay: number;
}

export type RelayOutcome = 'relayed' | 'not_submittable' | 'rejected' | 'over_budget';

export class Relayer {
  constructor(
    private readonly pool: Pool,
    private readonly rpc: NearRpc,
    private readonly signer: Signer,
    private readonly nonces: NonceSource,
    private readonly budget: Budget,
    private readonly cfg: RelayConfig,
    private readonly log: Logger,
    private readonly sponsor: StorageSponsor,
  ) {}

  async relay(opId: string): Promise<RelayOutcome> {
    const op = (
      await this.pool.query<{ uid: string; account_id: string; status: string; signed_delegate: string | null; relay_attempts: number }>(
        'select uid, account_id, status, signed_delegate, relay_attempts from ops.prepared_ops where op_id = $1',
        [opId],
      )
    ).rows[0];
    if (!op || !op.signed_delegate || !['SUBMITTED', 'RELAYED', 'UNKNOWN'].includes(op.status)) return 'not_submittable';
    const check = checkRelayable(op.signed_delegate, { accountSuffix: this.cfg.accountSuffix, allowedMethods: DEFAULT_RELAY_METHODS, maxGas: this.cfg.maxGas });
    if (!check.ok || check.sender !== op.account_id) {
      await this.fail(opId, op.uid, check.ok ? 'sender_mismatch' : check.reason);
      return 'rejected';
    }
    const day = new Date().toISOString().slice(0, 10);
    if (!(await this.budget.take(`relay:${op.uid}:${day}`, this.cfg.maxRelaysPerUserPerDay, 172_800))) {
      await this.fail(opId, op.uid, 'relay_budget');
      return 'over_budget';
    }
    await this.sponsor.ensure(op.account_id, check.method);
    const tx = await buildSignedTx(this.rpc, this.signer, this.nonces, this.cfg.relayerAccount, op.account_id, [signedDelegateAction(op.signed_delegate)]);
    await withTx(this.pool, async (c) => {
      await c.query(
        "update ops.prepared_ops set status = 'RELAYED', relay_tx_hashes = array_append(relay_tx_hashes, $2), relay_attempts = relay_attempts + 1, updated_at = now() where op_id = $1",
        [opId, tx.hash],
      );
      await c.query('insert into infra.outbox(topic, payload) values ($1, $2)', [TOPICS.ingest, JSON.stringify({ tx_hash: tx.hash, sender: this.cfg.relayerAccount })]);
    });
    try {
      await this.rpc.sendTx(tx.signedBase64, 'INCLUDED_FINAL');
    } catch (err) {
      if (err instanceof RpcError && /InvalidNonce|INVALID_TRANSACTION/.test(err.message)) {
        await this.nonces.reset(this.cfg.relayerAccount, await this.signer.publicKey());
        throw err;
      }
      this.log.warn({ opId, tx: tx.hash }, 'relay outcome unknown; indexer will resolve by hash');
      await this.pool.query("update ops.prepared_ops set status = 'UNKNOWN', updated_at = now() where op_id = $1 and status = 'RELAYED'", [opId]);
    }
    return 'relayed';
  }

  private async fail(opId: string, uid: string, reason: string) {
    await withTx(this.pool, async (c) => {
      await c.query("update ops.prepared_ops set status = 'FAILED', updated_at = now() where op_id = $1 and status in ('SUBMITTED', 'RELAYED', 'UNKNOWN')", [opId]);
      await c.query("select ledger.close_hold($1, 'RELEASED')", [`op:${opId}`]);
      await c.query("insert into audit.log(actor, action, target, outcome, details) values ($1, 'op.relay', $2, 'DENIED', $3)", [uid, opId, JSON.stringify({ reason })]);
    });
  }
}

const NO_PUBLISH: EventPublisher = { publish: async () => 0 };

export function swapHashes(st: Pick<OneClickStatus, 'swapDetails'>): { origin: string[]; near: string[] } {
  const pick = (v: Array<{ hash: string }> | undefined) =>
    (v ?? []).map((h) => h?.hash).filter((h): h is string => typeof h === 'string' && /^[0-9A-Za-z]{32,90}$/.test(h)).slice(0, 10);
  return { origin: pick(st.swapDetails?.originChainTxHashes), near: pick(st.swapDetails?.destinationChainTxHashes) };
}

const ACTIVE_DEPOSIT_STATES = ['AWAITING_DEPOSIT', 'DETECTED', 'CONVERTING', 'INCOMPLETE', 'REFUND_PENDING', 'VERIFYING_SETTLEMENT'];
const VERIFY_TIMEOUT_MINUTES = 30;
const QUOTE_GRACE_HOURS = 72;

interface DepositPollRow {
  id: string;
  uid: string;
  deposit_address: string;
  deposit_memo: string | null;
  status: string;
  stale: boolean;
  expired: boolean;
  tx_hashes: unknown;
  origin_asset: string;
  amount_formatted: string | null;
}

const DECIMAL = /^\d{1,30}(\.\d{1,24})?$/;

export function depositEmail(d: Pick<DepositPollRow, 'id' | 'uid' | 'origin_asset' | 'amount_formatted'>, to: states.DepositState, at = new Date().toISOString()): TypedEmailJob | null {
  const facts = { depositId: d.id, origin: originLabel(d.origin_asset), amount: d.amount_formatted && DECIMAL.test(d.amount_formatted) ? d.amount_formatted : null, at };
  const target = { uid: d.uid };
  switch (to) {
    case 'DETECTED':
    case 'CONVERTING':
    case 'VERIFYING_SETTLEMENT':
      return emailJob('DEPOSIT_PENDING', target, `deposit:${d.id}:PENDING`, facts);
    case 'REVIEW_REQUIRED':
      return emailJob('DEPOSIT_REVIEW', target, `deposit:${d.id}:REVIEW`, facts);
    case 'EXPIRED':
      return emailJob('DEPOSIT_FAILED', target, `deposit:${d.id}:EXPIRED`, { ...facts, reason: 'EXPIRED' });
    case 'INCOMPLETE':
    case 'REFUND_PENDING':
      return emailJob('DEPOSIT_FAILED', target, `deposit:${d.id}:REFUNDING`, { ...facts, reason: 'REFUNDING' });
    case 'REFUNDED':
      return emailJob('DEPOSIT_FAILED', target, `deposit:${d.id}:REFUNDED`, { ...facts, reason: 'REFUNDED' });
    case 'FAILED':
      return emailJob('DEPOSIT_FAILED', target, `deposit:${d.id}:FAILED`, { ...facts, reason: 'FAILED' });
    default:
      return null;
  }
}

export class DepositPoller {
  constructor(
    private readonly pool: Pool,
    private readonly oneclick: Pick<OneClickClient, 'status'>,
    private readonly intentsSender: string,
    private readonly log: Logger,
    private readonly publisher: EventPublisher = NO_PUBLISH,
  ) {}

  async pollBatch(limit = 25): Promise<number> {
    const rows = (
      await this.pool.query<DepositPollRow>(
        `select id, uid, deposit_address, deposit_memo, status, tx_hashes, origin_asset, quote->'quote'->>'amountInFormatted' as amount_formatted,
                updated_at < now() - make_interval(mins => $2) as stale,
                created_at < now() - make_interval(hours => $3) as expired
           from ops.deposits where status = any($1) order by updated_at limit $4`,
        [ACTIVE_DEPOSIT_STATES, VERIFY_TIMEOUT_MINUTES, QUOTE_GRACE_HOURS + 1, limit],
      )
    ).rows;
    let moved = 0;
    for (const d of rows) {
      if (d.status === 'VERIFYING_SETTLEMENT' && d.stale) {
        moved += await this.move(d, 'REVIEW_REQUIRED', { reason: 'settlement_not_verified' });
        continue;
      }
      let st;
      try {
        st = await this.oneclick.status(d.deposit_address, d.deposit_memo);
      } catch {
        continue;
      }
      const hashes = swapHashes(st);
      const hashesChanged = JSON.stringify(hashes) !== JSON.stringify(d.tx_hashes ?? {});
      let next = depositState(st.status);
      if (!next && d.expired && d.status === 'AWAITING_DEPOSIT') next = 'EXPIRED';
      if (!next || next === d.status) {
        if (hashesChanged && (hashes.origin.length || hashes.near.length)) {
          await this.pool.query('update ops.deposits set tx_hashes = $2, updated_at = now() where id = $1', [d.id, JSON.stringify(hashes)]);
          await publishUserEvents(this.publisher, [{ uid: d.uid, kind: 'deposit', id: d.id, status: d.status }]);
        }
        continue;
      }
      if (!states.deposit.can(d.status as states.DepositState, next)) {
        this.log.warn({ deposit: d.id, from: d.status, to: next }, 'ignoring impossible deposit transition');
        continue;
      }
      await withTx(this.pool, async (c) => {
        const email = depositEmail(d, next!);
        if (email) await enqueueEmail(c, email);
        if (next === 'VERIFYING_SETTLEMENT') {
          for (const h of st.swapDetails?.destinationChainTxHashes ?? []) {
            if (typeof h.hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(h.hash)) continue;
            await c.query('insert into infra.outbox(topic, payload) values ($1, $2)', [TOPICS.ingest, JSON.stringify({ tx_hash: h.hash, sender: this.intentsSender, deposit_id: d.id })]);
          }
        }
        await c.query('update ops.deposits set status = $3, tx_hashes = $4, updated_at = now() where id = $1 and status = $2', [d.id, d.status, next, JSON.stringify(hashes)]);
      });
      await publishUserEvents(this.publisher, [{ uid: d.uid, kind: 'deposit', id: d.id, status: next }]);
      moved++;
    }
    return moved;
  }

  private async move(d: DepositPollRow, to: states.DepositState, details: Record<string, string>): Promise<number> {
    await withTx(this.pool, async (c) => {
      await c.query('update ops.deposits set status = $3, updated_at = now() where id = $1 and status = $2', [d.id, d.status, to]);
      await c.query("insert into audit.log(actor, action, target, outcome, details) values ($1, 'deposit.review', $2, 'FAILED', $3)", [d.uid, d.id, JSON.stringify(details)]);
      const email = depositEmail(d, to);
      if (email) await enqueueEmail(c, email);
    });
    await publishUserEvents(this.publisher, [{ uid: d.uid, kind: 'deposit', id: d.id, status: to }]);
    return 1;
  }
}

export class Reconciler {
  constructor(
    private readonly pool: Pool,
    private readonly rpc: NearRpc,
    private readonly tokens: TokenSpec[],
    private readonly log: Logger,
  ) {}

  async reconcile(limit = 50): Promise<{ checked: number; mismatched: string[]; height: bigint }> {
    const final = (await this.rpc.finalBlock()).height;
    const cursor = (await this.pool.query<{ block_height: string }>("select block_height::text from chain.cursor where stream = 'blocks'")).rows[0];
    const height = cursor && BigInt(cursor.block_height) < final ? BigInt(cursor.block_height) : final;
    const accounts = (await this.pool.query<{ account_id: string }>("select account_id from chain.accounts where status = 'active' order by account_id limit $1", [limit])).rows;
    const mismatched: string[] = [];
    const currencies = [...new Set(this.tokens.map((t) => t.currency))];
    for (const { account_id } of accounts) {
      for (const currency of currencies) {
        const group = this.tokens.filter((t) => t.currency === currency);
        const ledger = await this.pool.query<{ posted: string }>(
          `select coalesce(sum(e.amount), 0)::text as posted
             from ledger.entries e
             join ledger.journals j on j.id = e.journal_id
             join ledger.accounts a on a.id = e.account_id
             left join chain.events ev on ev.receipt_id = j.source->>'receipt_id' and ev.log_index = (j.source->>'log_index')::integer
            where a.domain = 'REAL' and a.kind = 'WALLET' and a.ref = $1 and a.currency = $2
              and (ev.block_height is null or ev.block_height <= $3)`,
          [`wallet:${account_id}`, currency, height.toString()],
        );
        const posted = BigInt(ledger.rows[0]?.posted ?? '0');
        let chain = 0n;
        for (const t of group) chain += BigInt(await this.rpc.view<string>(t.token, 'ft_balance_of', { account_id }, height));
        const matched = posted === chain;
        const token = group.map((t) => t.token).join(',');
        await this.pool.query('insert into ops.reconciliation_runs(account_id, token, ledger_posted, chain_balance, matched) values ($1, $2, $3, $4, $5)', [
          account_id,
          token,
          posted.toString(),
          chain.toString(),
          matched,
        ]);
        if (!matched) {
          mismatched.push(account_id);
          await this.pool.query("update chain.accounts set status = 'frozen' where account_id = $1 and status = 'active'", [account_id]);
          await this.pool.query("insert into audit.log(actor, action, target, outcome, details) values ('reconciler', 'ledger.mismatch', $1, 'FAILED', $2)", [
            account_id,
            JSON.stringify({ token, ledger: posted.toString(), chain: chain.toString() }),
          ]);
          this.log.error({ account_id, token }, 'ledger does not match chain; outgoing operations paused for this account');
        }
      }
    }
    return { checked: accounts.length, mismatched, height };
  }

  async reapHolds(limit = 100): Promise<number> {
    const rows = (await this.pool.query<{ op_ref: string }>('select op_ref from ledger.expired_holds($1)', [limit])).rows;
    for (const { op_ref } of rows) await this.pool.query("select ledger.close_hold($1, 'RELEASED')", [op_ref]);
    return rows.length;
  }
}
