import { randomInt } from 'node:crypto';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { resolveSandboxReview, withTx } from '@obiba/db';
import { KILL_SWITCHES, MAX_KILL_SWITCH_MINUTES, killSwitchKey, publishUserEvents, states, type KillSwitchName } from '@obiba/domain';

export class AdminError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export type ReviewType = 'deposit' | 'withdrawal' | 'invoice_payment' | 'sandbox';

export interface ReviewItem {
  type: ReviewType | 'op_unknown' | 'recovery_failed';
  id: string;
  uid: string | null;
  status: string;
  detail: Record<string, unknown>;
  updatedAt: string;
}

const NOTE = /^[\x20-\x7e]{3,300}$/;

function note(value: unknown): string {
  if (typeof value !== 'string' || !NOTE.test(value)) throw new AdminError(400, 'a note of 3-300 printable characters is required');
  return value;
}

export class AdminService {
  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
  ) {}

  private async audit(actor: string, action: string, target: string, details: Record<string, unknown>, c?: { query: Pool['query'] }) {
    await (c ?? this.pool).query("insert into audit.log(actor, action, target, outcome, details) values ($1, $2, $3, 'ALLOWED', $4)", [`staff:${actor}`, action, target, JSON.stringify(details)]);
  }

  async overview() {
    const r = await this.pool.query<Record<string, string>>(
      `select
         (select count(*) from ops.deposits where status = 'REVIEW_REQUIRED')::text as deposits_review,
         (select count(*) from ops.withdrawals where status = 'REVIEW_REQUIRED')::text as withdrawals_review,
         (select count(*) from ops.invoice_deposits where status = 'REVIEW_REQUIRED')::text as invoice_payments_review,
         (select count(*) from ops.sandbox_ops where status = 'REVIEW')::text as sandbox_review,
         (select count(*) from ops.prepared_ops where status = 'UNKNOWN')::text as ops_unknown,
         (select count(*) from chain.accounts where status = 'frozen')::text as accounts_frozen,
         (select count(*) from identity.users where not pilot_allowed)::text as pilot_waiting,
         (select count(*) from ops.reconciliation_runs where not matched and checked_at > now() - interval '24 hours')::text as mismatches_24h`,
    );
    return { counts: r.rows[0], killSwitches: await this.killSwitches() };
  }

  async reviewQueue(limit = 100): Promise<ReviewItem[]> {
    const r = await this.pool.query<{ type: ReviewItem['type']; id: string; uid: string | null; status: string; detail: Record<string, unknown>; updated_at: Date }>(
      `select * from (
         select 'deposit' as type, id::text, uid, status, jsonb_build_object('origin', origin_asset, 'min_amount_out', min_amount_out::text, 'tx_hashes', tx_hashes) as detail, updated_at
           from ops.deposits where status = 'REVIEW_REQUIRED'
         union all
         select 'withdrawal', id::text, uid, status, jsonb_build_object('destination', destination, 'recipient', recipient, 'amount_in', amount_in::text, 'evidence', evidence, 'tx_hashes', tx_hashes), updated_at
           from ops.withdrawals where status = 'REVIEW_REQUIRED'
         union all
         select 'invoice_payment', d.id::text, i.merchant_uid, d.status, jsonb_build_object('invoice_id', d.invoice_id, 'invoice_status', i.status, 'refund_to', d.refund_to, 'tx_hashes', d.tx_hashes), d.updated_at
           from ops.invoice_deposits d join ops.invoices i on i.invoice_id = d.invoice_id where d.status = 'REVIEW_REQUIRED'
         union all
         select 'sandbox', id::text, uid, status, jsonb_build_object('kind', kind, 'provider', provider, 'amount', amount::text), updated_at
           from ops.sandbox_ops where status = 'REVIEW'
         union all
         select 'op_unknown', op_id, uid, status, jsonb_build_object('receiver', receiver, 'amount', amount::text, 'relay_tx_hashes', relay_tx_hashes), updated_at
           from ops.prepared_ops where status = 'UNKNOWN' and updated_at < now() - interval '10 minutes'
         union all
         select 'recovery_failed', id::text, uid, status, jsonb_build_object('reason', reason), updated_at
           from ops.recoveries where status = 'FAILED' and updated_at > now() - interval '7 days'
       ) q order by updated_at limit $1`,
      [limit],
    );
    return r.rows.map((x) => ({ type: x.type, id: x.id, uid: x.uid, status: x.status, detail: x.detail, updatedAt: new Date(x.updated_at).toISOString() }));
  }

  async resolve(actor: string, type: ReviewType, id: string, to: string, rawNote: unknown) {
    const why = note(rawNote);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AdminError(400, 'invalid id');
    return withTx(this.pool, async (c) => {
      let uid: string | null = null;
      if (type === 'deposit') {
        const d = (await c.query<{ uid: string; account_id: string; min_amount_out: string; created_at: Date }>(
          "select uid, account_id, min_amount_out::text, created_at from ops.deposits where id = $1 and status = 'REVIEW_REQUIRED' for update",
          [id],
        )).rows[0];
        if (!d) throw new AdminError(404, 'no deposit awaiting review');
        if (!states.deposit.can('REVIEW_REQUIRED', to as states.DepositState)) throw new AdminError(400, 'transition not allowed');
        let evidence: Record<string, unknown> | null = null;
        if (to === 'CREDITED') {
          const ev = (await c.query<{ receipt_id: string; log_index: number; amount: string }>(
            `select e.receipt_id, e.log_index, e.amount::text from chain.events e
              where e.to_account = $1 and e.amount >= $2 and e.observed_at >= $3
                and not exists (select 1 from ops.deposits o where o.credited_event->>'receipt_id' = e.receipt_id and (o.credited_event->>'log_index')::integer = e.log_index)
              order by e.observed_at limit 1`,
            [d.account_id, d.min_amount_out, d.created_at],
          )).rows[0];
          if (!ev) throw new AdminError(409, 'no unclaimed on-chain transfer proves this deposit');
          evidence = { receipt_id: ev.receipt_id, log_index: ev.log_index, amount: ev.amount, resolved_by: actor };
        }
        await c.query('update ops.deposits set status = $2, credited_event = coalesce($3::jsonb, credited_event), updated_at = now() where id = $1', [id, to, evidence ? JSON.stringify(evidence) : null]);
        uid = d.uid;
      } else if (type === 'withdrawal') {
        const w = (await c.query<{ uid: string }>("select uid from ops.withdrawals where id = $1 and status = 'REVIEW_REQUIRED' for update", [id])).rows[0];
        if (!w) throw new AdminError(404, 'no withdrawal awaiting review');
        if (!states.withdrawal.can('REVIEW_REQUIRED', to as states.WithdrawalState)) throw new AdminError(400, 'transition not allowed');
        await c.query("update ops.withdrawals set status = $2, evidence = coalesce(evidence, '{}'::jsonb) || $3::jsonb, updated_at = now() where id = $1", [id, to, JSON.stringify({ resolved_by: actor, note: why })]);
        uid = w.uid;
      } else if (type === 'invoice_payment') {
        const p = (await c.query<{ invoice_id: string; invoice_status: string; merchant_uid: string }>(
          "select d.invoice_id, i.status as invoice_status, i.merchant_uid from ops.invoice_deposits d join ops.invoices i on i.invoice_id = d.invoice_id where d.id = $1 and d.status = 'REVIEW_REQUIRED' for update of d",
          [id],
        )).rows[0];
        if (!p) throw new AdminError(404, 'no invoice payment awaiting review');
        if (!states.invoiceDeposit.can('REVIEW_REQUIRED', to as states.InvoiceDepositState)) throw new AdminError(400, 'transition not allowed');
        if (to === 'COMPLETED' && p.invoice_status !== 'PAID') throw new AdminError(409, 'the invoice is not paid on-chain');
        await c.query('update ops.invoice_deposits set status = $2, updated_at = now() where id = $1', [id, to]);
        if (to === 'REFUNDED') await c.query('select ops.release_invoice($1)', [p.invoice_id]);
        uid = p.merchant_uid;
      } else {
        if (to !== 'SUCCEEDED' && to !== 'FAILED') throw new AdminError(400, 'transition not allowed');
        const r = await resolveSandboxReview(c, id, to, () => Array.from({ length: 20 }, () => randomInt(10)).join(''));
        if (!r) throw new AdminError(404, 'no sandbox operation awaiting review');
        uid = r.uid;
      }
      await this.audit(actor, `review.${type}`, id, { to, note: why }, c);
      if (uid) await publishUserEvents(this.redis, [{ uid, kind: type === 'invoice_payment' ? 'invoice' : type === 'sandbox' ? 'balance' : type, id, status: to }]);
      return { id, type, status: to };
    });
  }

  async reconciliation(mismatchedOnly: boolean, limit = 100) {
    const r = await this.pool.query(
      `select id::text, account_id, token, ledger_posted::text, chain_balance::text, matched, checked_at
         from ops.reconciliation_runs where ($1 = false or not matched) order by checked_at desc limit $2`,
      [mismatchedOnly, limit],
    );
    return r.rows;
  }

  async setAccountStatus(actor: string, accountId: string, status: unknown, rawNote: unknown) {
    const why = note(rawNote);
    if (status !== 'active' && status !== 'frozen') throw new AdminError(400, 'status must be active or frozen');
    if (typeof accountId !== 'string' || accountId.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*\.[a-z0-9.-]+$/.test(accountId)) throw new AdminError(400, 'invalid account');
    return withTx(this.pool, async (c) => {
      const from = status === 'active' ? 'frozen' : 'active';
      const r = await c.query<{ uid: string }>('update chain.accounts set status = $2 where account_id = $1 and status = $3 returning uid', [accountId, status, from]);
      if (!r.rows[0]) throw new AdminError(409, `account is not ${from}`);
      await this.audit(actor, 'account.status', accountId, { to: status, note: why }, c);
      await publishUserEvents(this.redis, [{ uid: r.rows[0].uid, kind: 'account', id: accountId, status: status.toUpperCase() }]);
      return { accountId, status };
    });
  }

  async killSwitches() {
    const out: Array<{ name: KillSwitchName; active: boolean; secondsLeft: number | null }> = [];
    for (const name of KILL_SWITCHES) {
      const ttl = await this.redis.ttl(killSwitchKey(name));
      out.push({ name, active: ttl > 0 || ttl === -1, secondsLeft: ttl > 0 ? ttl : null });
    }
    return out;
  }

  async setKillSwitch(actor: string, name: string, minutes: unknown, rawNote: unknown) {
    const why = note(rawNote);
    if (!KILL_SWITCHES.includes(name as KillSwitchName)) throw new AdminError(404, 'unknown kill switch');
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_KILL_SWITCH_MINUTES) {
      throw new AdminError(400, `minutes must be 1-${MAX_KILL_SWITCH_MINUTES}; switches always re-enable themselves`);
    }
    await this.redis.set(killSwitchKey(name as KillSwitchName), actor, 'EX', minutes * 60);
    await this.audit(actor, 'killswitch.on', name, { minutes, note: why });
    return { name, active: true, secondsLeft: minutes * 60 };
  }

  async clearKillSwitch(actor: string, name: string, rawNote: unknown) {
    const why = note(rawNote);
    if (!KILL_SWITCHES.includes(name as KillSwitchName)) throw new AdminError(404, 'unknown kill switch');
    await this.redis.del(killSwitchKey(name as KillSwitchName));
    await this.audit(actor, 'killswitch.off', name, { note: why });
    return { name, active: false, secondsLeft: null };
  }

  async pilotRequests(limit = 100) {
    const r = await this.pool.query(
      `select u.uid, u.display_name, u.created_at, d.status as device_status
         from identity.users u left join identity.devices d on d.uid = u.uid and d.initial
        where not u.pilot_allowed and u.status = 'active' order by u.created_at limit $1`,
      [limit],
    );
    return r.rows;
  }

  async setPilot(actor: string, uid: string, allowed: unknown) {
    if (typeof allowed !== 'boolean') throw new AdminError(400, 'allowed must be a boolean');
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid)) throw new AdminError(400, 'invalid uid');
    return withTx(this.pool, async (c) => {
      const r = await c.query('update identity.users set pilot_allowed = $2, updated_at = now() where uid = $1 returning uid', [uid, allowed]);
      if (!r.rowCount) throw new AdminError(404, 'unknown user');
      let queued = false;
      if (allowed) {
        const ready = await c.query("select 1 from identity.devices d where d.uid = $1 and d.initial and not exists (select 1 from chain.accounts a where a.uid = $1 and a.status = 'active')", [uid]);
        if (ready.rowCount) {
          await c.query("insert into infra.outbox(topic, payload) values ('account.provision', $1)", [JSON.stringify({ uid })]);
          queued = true;
        }
      }
      await this.audit(actor, 'pilot.set', uid, { allowed, provisioning_queued: queued }, c);
      return { uid, allowed, provisioningQueued: queued };
    });
  }

  async setMerchant(actor: string, uid: string, merchant: unknown, rawNote: unknown) {
    const why = note(rawNote);
    if (typeof merchant !== 'boolean') throw new AdminError(400, 'merchant must be a boolean');
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid)) throw new AdminError(400, 'invalid uid');
    return withTx(this.pool, async (c) => {
      const r = await c.query('update identity.users set merchant = $2, updated_at = now() where uid = $1 returning uid', [uid, merchant]);
      if (!r.rowCount) throw new AdminError(404, 'unknown user');
      await this.audit(actor, 'merchant.set', uid, { merchant, note: why, on_chain_registration: 'manual: pay-contract owner must call register_merchant' }, c);
      return { uid, merchant };
    });
  }

  async setInternalTester(actor: string, uid: string, enabled: unknown, rawNote: unknown) {
    const why = note(rawNote);
    if (typeof enabled !== 'boolean') throw new AdminError(400, 'enabled must be a boolean');
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid)) throw new AdminError(400, 'invalid uid');
    return withTx(this.pool, async (c) => {
      const r = await c.query('update identity.users set internal_tester = $2, updated_at = now() where uid = $1 returning uid', [uid, enabled]);
      if (!r.rowCount) throw new AdminError(404, 'unknown user');
      await this.audit(actor, 'internal_tester.set', uid, { enabled, note: why }, c);
      return { uid, internalTester: enabled };
    });
  }
}
