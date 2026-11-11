import { randomInt } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';
import { withTx } from '@obiba/db';
import { creditDedupeKey, emailJob, enqueueEmail, originLabel, publishUserEvents, type EventPublisher, type TokenSpec, type UserEvent } from '@obiba/domain';
import { RpcError, extractEvents, extractFromOutcomes, type BlockOutcomes, type NearRpc, type ObibaEvent, type TransferEvent } from '@obiba/near';

export interface IngestConfig {
  tokens: TokenSpec[];
  accountSuffix: string;
  payContract: string;
  treasury: string;
}

export type IngestOutcome = 'ingested' | 'duplicate' | 'pending';

export const BLOCK_STREAM = 'blocks';

export class CursorConflictError extends Error {}

const HEX_ID = /^[0-9a-f]{32}$/;
const NO_PUBLISH: EventPublisher = { publish: async () => 0 };

type Notice = { uid: string } & UserEvent;

export class Ingestor {
  private readonly tokens: Map<string, TokenSpec>;

  constructor(
    private readonly pool: Pool,
    private readonly rpc: NearRpc,
    private readonly cfg: IngestConfig,
    private readonly log: Logger,
    private readonly publisher: EventPublisher = NO_PUBLISH,
  ) {
    this.tokens = new Map(cfg.tokens.map((t) => [t.token, t]));
  }

  async ingest(txHash: string, sender: string, depositId?: string): Promise<IngestOutcome> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(txHash)) throw new Error('invalid tx hash');
    const seen = await this.pool.query('select 1 from chain.ingested_txs where tx_hash = $1', [txHash]);
    if (seen.rowCount) return 'duplicate';
    let status;
    try {
      status = await this.rpc.txStatus(txHash, sender);
    } catch (err) {
      if (err instanceof RpcError && /UNKNOWN_TRANSACTION|TIMEOUT_ERROR/.test(err.message)) return 'pending';
      throw err;
    }
    const events = extractEvents(status, this.scope());
    const heights = new Map<string, bigint>();
    for (const hash of new Set(events.transfers.map((t) => t.blockHash).filter((h): h is string => typeof h === 'string'))) {
      heights.set(hash, await this.rpc.blockHeight(hash));
    }
    const notices: Notice[] = [];
    await withTx(this.pool, async (c) => {
      const tracked = await this.trackedAccounts(c, events.transfers);
      for (const e of events.obiba) await this.settle(c, e, notices);
      const fresh: TransferEvent[] = [];
      for (const t of events.transfers) if (await this.record(c, t, tracked, txHash, (t.blockHash && heights.get(t.blockHash)) || 0n, false)) fresh.push(t);
      await c.query('insert into chain.ingested_txs(tx_hash, sender) values ($1, $2) on conflict do nothing', [txHash, sender]);
      await this.failAbandoned(c, txHash, notices);
      const credited = depositId ? await this.creditDeposit(c, depositId, events.transfers, notices, txHash) : null;
      await this.emailCredits(c, fresh.filter((t) => t !== credited), tracked, txHash);
      notices.push(...(await this.balanceNotices(c, events.transfers, tracked)));
    });
    await publishUserEvents(this.publisher, notices);
    this.log.info({ tx: txHash, transfers: events.transfers.length, events: events.obiba.length }, 'ingested transaction');
    return 'ingested';
  }

  async ingestBlock(block: BlockOutcomes | null, height: bigint, previous: bigint | null): Promise<number> {
    const events = block ? extractFromOutcomes(block.outcomes, this.scope()) : { transfers: [], obiba: [] };
    const notices: Notice[] = [];
    await withTx(this.pool, async (c) => {
      const tracked = await this.trackedAccounts(c, events.transfers);
      for (const e of events.obiba) await this.settle(c, e, notices);
      const fresh: TransferEvent[] = [];
      for (const t of events.transfers) if (await this.record(c, t, tracked, t.txHash ?? null, height, true)) fresh.push(t);
      for (const t of fresh) await this.emailCredits(c, [t], tracked, t.txHash ?? null);
      notices.push(...(await this.balanceNotices(c, events.transfers, tracked)));
      const moved =
        previous === null
          ? await c.query('insert into chain.cursor(stream, block_height) values ($1, $2) on conflict do nothing', [BLOCK_STREAM, height.toString()])
          : await c.query('update chain.cursor set block_height = $3 where stream = $1 and block_height = $2', [BLOCK_STREAM, previous.toString(), height.toString()]);
      if (!moved.rowCount) throw new CursorConflictError('block cursor moved concurrently');
    });
    await publishUserEvents(this.publisher, notices);
    return events.transfers.length + events.obiba.length;
  }

  private scope() {
    return {
      tokens: new Set(this.tokens.keys()),
      isObibaEmitter: (a: string) => a === this.cfg.payContract || a.endsWith(this.cfg.accountSuffix),
    };
  }

  private async trackedAccounts(c: PoolClient, transfers: TransferEvent[]): Promise<Set<string>> {
    const candidates = [...new Set(transfers.flatMap((t) => [t.from, t.to]))].filter((a) => a.endsWith(this.cfg.accountSuffix));
    if (candidates.length === 0) return new Set();
    const r = await c.query<{ account_id: string }>('select account_id from chain.accounts where account_id = any($1)', [candidates]);
    return new Set(r.rows.map((x) => x.account_id));
  }

  private ledgerRef(account: string, tracked: Set<string>): { kind: string; ref: string } {
    if (tracked.has(account)) return { kind: 'WALLET', ref: `wallet:${account}` };
    if (account === this.cfg.payContract) return { kind: 'CLEARING', ref: `clearing:${account}` };
    if (account === this.cfg.treasury) return { kind: 'TREASURY', ref: `treasury:${account}` };
    return { kind: 'EXTERNAL', ref: `external:${account}` };
  }

  private async balanceNotices(c: PoolClient, transfers: TransferEvent[], tracked: Set<string>): Promise<Notice[]> {
    const accounts = [...new Set(transfers.flatMap((t) => [t.from, t.to]).filter((a) => tracked.has(a)))];
    if (accounts.length === 0) return [];
    const r = await c.query<{ uid: string; account_id: string }>('select uid, account_id from chain.accounts where account_id = any($1)', [accounts]);
    return r.rows.map((x) => ({ uid: x.uid, kind: 'balance' as const, id: x.account_id, status: 'POSTED' }));
  }

  private async record(c: PoolClient, t: TransferEvent, tracked: Set<string>, txHash: string | null, height: bigint, onlyRelevant: boolean): Promise<boolean> {
    const token = this.tokens.get(t.token);
    if (!token) return false;
    const relevant = tracked.has(t.from) || tracked.has(t.to) || [t.from, t.to].includes(this.cfg.payContract);
    if (onlyRelevant && !relevant) return false;
    const inserted = await c.query(
      `insert into chain.events(receipt_id, log_index, block_height, kind, token, from_account, to_account, amount, tx_hash, raw)
       values ($1, $2, $3, 'ft_transfer', $4, $5, $6, $7, $8, $9) on conflict do nothing`,
      [t.receiptId, t.logIndex, height.toString(), t.token, t.from, t.to, t.amount.toString(), txHash, JSON.stringify({ memo: t.memo })],
    );
    if (!relevant) return false;
    const ids: string[] = [];
    for (const account of [t.to, t.from]) {
      const { kind, ref } = this.ledgerRef(account, tracked);
      const r = await c.query<{ id: string }>("select ledger.ensure_account('REAL', $1, $2, $3) as id", [kind, ref, token.currency]);
      ids.push(r.rows[0]!.id);
    }
    await c.query("select ledger.post_real_journal($1, 'chain_transfer', $2::jsonb, $3::jsonb)", [
      `evt:${t.receiptId}:${t.logIndex}`,
      JSON.stringify([
        { account_id: ids[0], amount: t.amount.toString(), currency: token.currency },
        { account_id: ids[1], amount: (-t.amount).toString(), currency: token.currency },
      ]),
      JSON.stringify({ token: t.token, receipt_id: t.receiptId, log_index: t.logIndex }),
    ]);
    return (inserted.rowCount ?? 0) > 0;
  }

  private async emailCredits(c: PoolClient, transfers: TransferEvent[], tracked: Set<string>, txHash: string | null): Promise<void> {
    const credits = transfers.filter((t) => tracked.has(t.to) && t.amount > 0n && t.from !== this.cfg.payContract && t.from !== this.cfg.treasury);
    if (credits.length === 0) return;
    const owners = await c.query<{ uid: string; account_id: string }>('select uid, account_id from chain.accounts where account_id = any($1)', [[...new Set(credits.map((t) => t.to))]]);
    const uids = new Map(owners.rows.map((x) => [x.account_id, x.uid]));
    for (const t of credits) {
      const uid = uids.get(t.to);
      const token = this.tokens.get(t.token);
      if (!uid || !token) continue;
      await enqueueEmail(
        c,
        emailJob('DEPOSIT_CONFIRMED', { uid }, creditDedupeKey(t.receiptId, t.logIndex), {
          units: t.amount.toString(),
          decimals: token.decimals,
          currency: token.currency,
          reference: txHash ?? t.receiptId,
          method: tracked.has(t.from) ? 'Transfer from an Obiba account' : 'Direct transfer on NEAR',
          from: tracked.has(t.from) ? null : t.from,
          at: new Date().toISOString(),
        }),
      );
    }
  }

  private async creditDeposit(c: PoolClient, depositId: string, transfers: TransferEvent[], notices: Notice[], txHash: string): Promise<TransferEvent | null> {
    const d = (
      await c.query<{ account_id: string; min_amount_out: string; status: string; uid: string; origin_asset: string }>(
        'select account_id, min_amount_out::text, status, uid, origin_asset from ops.deposits where id = $1 for update',
        [depositId],
      )
    ).rows[0];
    if (!d || d.status !== 'VERIFYING_SETTLEMENT') return null;
    const hit = transfers.find((t) => t.to === d.account_id && this.tokens.has(t.token) && t.amount >= BigInt(d.min_amount_out));
    const next = hit ? 'CREDITED' : 'REVIEW_REQUIRED';
    const evidence = hit ? { receipt_id: hit.receiptId, log_index: hit.logIndex, token: hit.token, amount: hit.amount.toString() } : { reason: 'no matching transfer' };
    await c.query("update ops.deposits set status = $2, credited_event = $3, updated_at = now() where id = $1 and status = 'VERIFYING_SETTLEMENT'", [depositId, next, JSON.stringify(evidence)]);
    notices.push({ uid: d.uid, kind: 'deposit', id: depositId, status: next });
    const at = new Date().toISOString();
    const token = hit ? this.tokens.get(hit.token) : undefined;
    if (hit && token) {
      await enqueueEmail(
        c,
        emailJob('DEPOSIT_CONFIRMED', { uid: d.uid }, creditDedupeKey(hit.receiptId, hit.logIndex), {
          units: hit.amount.toString(),
          decimals: token.decimals,
          currency: token.currency,
          reference: txHash,
          method: originLabel(d.origin_asset),
          from: null,
          at,
        }),
      );
    } else {
      await enqueueEmail(c, emailJob('DEPOSIT_REVIEW', { uid: d.uid }, `deposit:${depositId}:REVIEW`, { depositId, origin: originLabel(d.origin_asset), amount: null, at }));
    }
    return hit ?? null;
  }

  private async failAbandoned(c: PoolClient, txHash: string, notices: Notice[]): Promise<void> {
    const ops = await c.query<{ op_id: string; uid: string; invoice_id: string | null }>(
      `select p.op_id, p.uid, p.invoice_id from ops.prepared_ops p
        where $1 = any(p.relay_tx_hashes) and p.status in ('RELAYED', 'UNKNOWN')
          and not exists (select 1 from unnest(p.relay_tx_hashes) h where h not in (select tx_hash from chain.ingested_txs))
        for update`,
      [txHash],
    );
    for (const { op_id, uid, invoice_id } of ops.rows) {
      await c.query("update ops.prepared_ops set status = 'FAILED', updated_at = now() where op_id = $1", [op_id]);
      await c.query("select ledger.close_hold($1, 'RELEASED')", [`op:${op_id}`]);
      if (invoice_id) await c.query('select ops.release_invoice($1)', [invoice_id]);
      await this.settleInternalTest(c, { opId: op_id }, 'FAILED', null, notices);
      notices.push({ uid, kind: 'op', id: op_id, status: 'FAILED' });
      await c.query("insert into audit.log(actor, action, target, outcome, details) values ('indexer', 'op.settle', $1, 'FAILED', $2)", [
        op_id,
        JSON.stringify({ reason: 'no settlement event in any relay attempt', tx: txHash }),
      ]);
    }
  }

  private async settleInternalTest(c: PoolClient, by: { invoiceId?: string; opId?: string }, status: 'SUCCEEDED' | 'FAILED', txHash: string | null, notices: Notice[]): Promise<void> {
    const rows = await c.query<{ id: string; uid: string; kind: string }>(
      `select id, uid, kind from ops.sandbox_ops
        where funding = 'REAL_INTERNAL' and status = 'PENDING' and (invoice_id = $1 or op_id = $2) for update`,
      [by.invoiceId ?? null, by.opId ?? null],
    );
    for (const r of rows.rows) {
      const token = status === 'SUCCEEDED' && r.kind === 'ECG' ? `PILOT-${Array.from({ length: 20 }, () => randomInt(10)).join('').match(/.{4}/g)!.join('-')}` : null;
      await c.query("update ops.sandbox_ops set status = $2, receipt = receipt || $3::jsonb, updated_at = now() where id = $1", [
        r.id,
        status,
        JSON.stringify({ token, paid_tx_hash: txHash }),
      ]);
      notices.push({ uid: r.uid, kind: 'balance', id: r.id, status: `INTERNAL_TEST_${status}` });
    }
  }

  private async settle(c: PoolClient, e: ObibaEvent, notices: Notice[]): Promise<void> {
    if (e.event === 'op_executed' || e.event === 'op_failed') {
      const opId = e.data.op_id;
      if (typeof opId !== 'string' || !HEX_ID.test(opId)) return;
      const settled = e.event === 'op_executed';
      const status = settled ? 'SETTLED' : 'FAILED';
      const r = await c.query<{ uid: string; invoice_id: string | null }>(
        "update ops.prepared_ops set status = $3, updated_at = now() where op_id = $1 and account_id = $2 and status in ('SUBMITTED', 'RELAYED', 'UNKNOWN') returning uid, invoice_id",
        [opId, e.emitter, status],
      );
      const row = r.rows[0];
      if (row) {
        await c.query('select ledger.close_hold($1, $2)', [`op:${opId}`, settled ? 'CAPTURED' : 'RELEASED']);
        if (!settled && row.invoice_id) await c.query('select ops.release_invoice($1)', [row.invoice_id]);
        if (!settled) await this.settleInternalTest(c, { opId }, 'FAILED', null, notices);
        if (settled) {
          const requester = (await c.query<{ uid: string | null }>('select ops.settle_money_request($1) as uid', [opId])).rows[0]?.uid;
          if (requester) notices.push({ uid: requester, kind: 'invoice', id: opId, status: 'PAID' });
        }
        notices.push({ uid: row.uid, kind: 'op', id: opId, status });
      }
      return;
    }
    if (e.event === 'invoice_paid' && e.emitter === this.cfg.payContract) {
      const id = e.data.invoice_id;
      if (typeof id === 'string' && HEX_ID.test(id)) {
        const amount = typeof e.data.amount === 'string' && /^\d{1,39}$/.test(e.data.amount) ? e.data.amount : null;
        const fee = typeof e.data.fee === 'string' && /^\d{1,39}$/.test(e.data.fee) ? e.data.fee : null;
        const evidence = {
          payer: typeof e.data.payer === 'string' ? e.data.payer.slice(0, 64) : null,
          amount,
          fee,
          net: amount !== null && fee !== null ? (BigInt(amount) - BigInt(fee)).toString() : null,
          receipt_id: e.receiptId,
          tx_hash: e.txHash ?? null,
          paid_at: new Date().toISOString(),
        };
        const r = await c.query<{ merchant_uid: string }>(
          "update ops.invoices set status = 'PAID', paid_event = $2 where invoice_id = $1 and status in ('OPEN', 'PAYING', 'EXPIRED') returning merchant_uid",
          [id, JSON.stringify(evidence)],
        );
        if (r.rows[0]) notices.push({ uid: r.rows[0].merchant_uid, kind: 'invoice', id, status: 'PAID' });
        await this.settleInternalTest(c, { invoiceId: id }, 'SUCCEEDED', e.txHash ?? null, notices);
      }
    }
  }
}
