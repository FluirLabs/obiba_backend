import type Redis from 'ioredis';
import type { Pool, PoolClient } from 'pg';
import { GoogleAuth } from 'google-auth-library';
import { withTx } from '@obiba/db';
import { SUPPORT_CHECKS, SUPPORT_OPEN_STATES, SUPPORT_REVIEW_HOURS, publishUserEvents, supportChecksPassed, supportEarliestAt } from '@obiba/domain';
import { AdminError } from './admin';
import type { IdentityAdmin } from './identity';

export type SupportGuardianResponse = { ok: true; signature: string; guardianNonce: string } | { ok: false; reason: string };

export interface SupportGuardian {
  supportRecovery(recoveryId: string): Promise<SupportGuardianResponse>;
}

export class HttpSupportGuardian implements SupportGuardian {
  private readonly auth = new GoogleAuth();

  constructor(
    private readonly url: string,
    private readonly audience: string,
  ) {}

  async supportRecovery(recoveryId: string): Promise<SupportGuardianResponse> {
    const client = await this.auth.getIdTokenClient(this.audience);
    const res = await client.request<SupportGuardianResponse>({ url: `${this.url}/v1/support-recovery`, method: 'POST', data: { recovery_id: recoveryId }, timeout: 10_000 });
    return res.data;
  }
}

export class DevSupportGuardian implements SupportGuardian {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async supportRecovery(recoveryId: string): Promise<SupportGuardianResponse> {
    const res = await fetch(`${this.url}/v1/support-recovery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ recovery_id: recoveryId }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (!res.ok) return { ok: false, reason: `guardian_http_${res.status}` };
    return (await res.json()) as SupportGuardianResponse;
  }
}

const ID = /^[0-9a-f-]{36}$/;
const TEXT = /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]{3,2000}$/;
const RETRY_AFTER_REFUSAL = '6 hours';

interface CaseRow {
  id: string;
  uid: string;
  account_id: string;
  new_public_key: string;
  status: string;
  checks: Record<string, unknown>;
  notes: string | null;
  verified_by: string | null;
  verified_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  closed_by: string | null;
  closed_reason: string | null;
  recovery_id: string | null;
  created_at: Date;
  display_name: string;
  email: string;
  phone_e164: string;
  account_status: string;
}

const CASE_SELECT = `select s.id, s.uid, s.account_id, s.new_public_key, s.status, s.checks, s.notes, s.verified_by, s.verified_at, s.approved_by, s.approved_at,
       s.closed_by, s.closed_reason, s.recovery_id, s.created_at, u.display_name, u.email, u.phone_e164, a.status as account_status
  from ops.support_cases s join identity.users u on u.uid = s.uid join chain.accounts a on a.account_id = s.account_id`;

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TEXT.test(value.trim())) throw new AdminError(400, `${field} of 3-2000 characters is required`);
  return value.trim();
}

function summary(r: CaseRow) {
  return {
    id: r.id,
    status: r.status,
    displayName: r.display_name,
    email: r.email,
    phone: r.phone_e164,
    accountId: r.account_id,
    createdAt: r.created_at.toISOString(),
    earliestAt: supportEarliestAt(r.created_at).toISOString(),
    verifiedBy: r.verified_by,
    approvedBy: r.approved_by,
  };
}

async function notify(c: PoolClient, uid: string, kind: string, ref: string, email: boolean): Promise<void> {
  const r = await c.query('insert into ops.notifications(uid, kind, ref) values ($1, $2, $3) on conflict do nothing', [uid, kind, ref]);
  if (email && r.rowCount) await c.query("insert into infra.outbox(topic, payload) values ('notify.email', $1)", [JSON.stringify({ uid, kind, ref })]);
}

export class SupportService {
  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
    private readonly guardian: SupportGuardian | null,
    private readonly identity: IdentityAdmin | null = null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async audit(c: PoolClient, actor: string, action: string, target: string, details: Record<string, unknown>, outcome: 'ALLOWED' | 'DENIED' | 'FAILED' = 'ALLOWED') {
    await c.query('insert into audit.log(actor, action, target, outcome, details) values ($1, $2, $3, $4, $5)', [`staff:${actor}`, action, target, outcome, JSON.stringify(details)]);
  }

  private async lock(c: PoolClient, id: string): Promise<CaseRow> {
    if (!ID.test(id)) throw new AdminError(400, 'invalid case id');
    const r = await c.query<CaseRow>(`${CASE_SELECT} where s.id = $1 for update of s`, [id]);
    if (!r.rows[0]) throw new AdminError(404, 'unknown support case');
    return r.rows[0];
  }

  private notHolder(actor: string, row: CaseRow): void {
    if (actor.toLowerCase() === row.email.toLowerCase()) throw new AdminError(409, 'staff cannot act on their own account');
  }

  async list(status: string | undefined) {
    const open = status === undefined || status === 'open';
    const r = await this.pool.query<CaseRow>(
      `${CASE_SELECT} where ($1 and s.status = any($2)) or (not $1 and s.status = $3) order by s.created_at limit 200`,
      [open, [...SUPPORT_OPEN_STATES], open ? '' : status],
    );
    return r.rows.map(summary);
  }

  async get(id: string) {
    if (!ID.test(id)) throw new AdminError(400, 'invalid case id');
    const r = await this.pool.query<CaseRow>(`${CASE_SELECT} where s.id = $1`, [id]);
    const row = r.rows[0];
    if (!row) throw new AdminError(404, 'unknown support case');
    const [user, devices, recoveries, cases, activity, local, trail, decisions] = await Promise.all([
      this.pool.query<{ created_at: Date; phone_verified_at: Date | null; status: string; handle: string | null }>('select created_at, phone_verified_at, status, handle from identity.users where uid = $1', [row.uid]),
      this.pool.query<{ public_key: string; status: string; initial: boolean; created_at: Date }>('select public_key, status, initial, created_at from identity.devices where uid = $1 order by created_at', [row.uid]),
      this.pool.query<{ id: string; method: string; status: string; reason: string | null; created_at: Date }>('select id, method, status, reason, created_at from ops.recoveries where uid = $1 order by created_at desc limit 10', [row.uid]),
      this.pool.query<{ id: string; status: string; created_at: Date; closed_reason: string | null }>('select id, status, created_at, closed_reason from ops.support_cases where uid = $1 and id <> $2 order by created_at desc limit 10', [row.uid, id]),
      this.pool.query<{ kind: string; token: string; from_account: string; to_account: string; amount: string; observed_at: Date }>(
        'select kind, token, from_account, to_account, amount::text, observed_at from chain.events where from_account = $1 or to_account = $1 order by block_height desc limit 10',
        [row.account_id],
      ),
      this.pool.query<{ kind: string; provider: string; status: string; amount: string; created_at: Date }>('select kind, provider, status, amount::text, created_at from ops.sandbox_ops where uid = $1 order by created_at desc limit 10', [row.uid]),
      this.pool.query<{ at: Date; actor: string; action: string; outcome: string; details: unknown }>("select at, actor, action, outcome, details from audit.log where target = $1 or (target = $2 and action like 'support%') order by at", [id, row.recovery_id ?? '']),
      row.recovery_id
        ? this.pool.query<{ outcome: string; rules: unknown; decided_at: Date }>('select outcome, rules, decided_at from ops.guardian_decisions where op_id = $1 order by decided_at desc limit 5', [`recovery:${row.recovery_id}`])
        : Promise.resolve({ rows: [] as Array<{ outcome: string; rules: unknown; decided_at: Date }> }),
    ]);
    const u = user.rows[0]!;
    return {
      ...summary(row),
      newPublicKey: row.new_public_key,
      checks: row.checks,
      notes: row.notes,
      verifiedAt: row.verified_at?.toISOString() ?? null,
      approvedAt: row.approved_at?.toISOString() ?? null,
      closedBy: row.closed_by,
      closedReason: row.closed_reason,
      recoveryId: row.recovery_id,
      requiredChecks: SUPPORT_CHECKS,
      reviewHours: SUPPORT_REVIEW_HOURS,
      user: { uid: row.uid, handle: u.handle, status: u.status, joinedAt: u.created_at.toISOString(), phoneVerifiedAt: u.phone_verified_at?.toISOString() ?? null },
      account: { accountId: row.account_id, status: row.account_status },
      devices: devices.rows.map((d) => ({ publicKey: d.public_key, status: d.status, initial: d.initial, createdAt: d.created_at.toISOString() })),
      recoveries: recoveries.rows.map((x) => ({ id: x.id, method: x.method, status: x.status, reason: x.reason, createdAt: x.created_at.toISOString() })),
      otherCases: cases.rows.map((x) => ({ id: x.id, status: x.status, closedReason: x.closed_reason, createdAt: x.created_at.toISOString() })),
      chainActivity: activity.rows.map((e) => ({ kind: e.kind, token: e.token, direction: e.to_account === row.account_id ? 'in' : 'out', counterparty: e.to_account === row.account_id ? e.from_account : e.to_account, amount: e.amount, at: e.observed_at.toISOString() })),
      localActivity: local.rows.map((x) => ({ kind: x.kind, provider: x.provider, status: x.status, amount: x.amount, at: x.created_at.toISOString() })),
      trail: trail.rows.map((t) => ({ at: t.at.toISOString(), actor: t.actor, action: t.action, outcome: t.outcome, details: t.details })),
      guardian: decisions.rows.map((d) => ({ outcome: d.outcome, rules: d.rules, at: d.decided_at.toISOString() })),
    };
  }

  async verify(actor: string, id: string, checks: unknown, rawNotes: unknown) {
    const notes = text(rawNotes, 'investigation notes');
    if (!supportChecksPassed(checks)) throw new AdminError(400, `every check must be confirmed: ${SUPPORT_CHECKS.join(', ')}`);
    const clean = Object.fromEntries(SUPPORT_CHECKS.map((k) => [k, true]));
    return withTx(this.pool, async (c) => {
      const row = await this.lock(c, id);
      this.notHolder(actor, row);
      if (row.status !== 'OPEN') throw new AdminError(409, `case is ${row.status.toLowerCase()}, not open`);
      await c.query("update ops.support_cases set status = 'VERIFIED', checks = $2, notes = $3, verified_by = $4, verified_at = now(), updated_at = now() where id = $1", [id, JSON.stringify(clean), notes, actor]);
      await this.audit(c, actor, 'support_case.verify', id, { checks: clean });
      return { id, status: 'VERIFIED' };
    });
  }

  async approve(actor: string, id: string, rawNote: unknown) {
    const reason = text(rawNote, 'an approval note');
    return withTx(this.pool, async (c) => {
      const row = await this.lock(c, id);
      this.notHolder(actor, row);
      if (row.status !== 'VERIFIED') throw new AdminError(409, `case is ${row.status.toLowerCase()}, not verified`);
      if (row.verified_by?.toLowerCase() === actor.toLowerCase()) throw new AdminError(409, 'a different staff member must approve the case they did not verify');
      await c.query("update ops.support_cases set status = 'APPROVED', approved_by = $2, approved_at = now(), updated_at = now() where id = $1", [id, actor]);
      await notify(c, row.uid, 'SUPPORT_CASE_APPROVED', id, true);
      await this.audit(c, actor, 'support_case.approve', id, { note: reason, earliest_at: supportEarliestAt(row.created_at).toISOString() });
      return { id, status: 'APPROVED', earliestAt: supportEarliestAt(row.created_at).toISOString() };
    });
  }

  async reject(actor: string, id: string, rawReason: unknown) {
    const reason = text(rawReason, 'a reason').slice(0, 500);
    const out = await withTx(this.pool, async (c) => {
      const row = await this.lock(c, id);
      if (!(SUPPORT_OPEN_STATES as readonly string[]).includes(row.status)) throw new AdminError(409, `case is ${row.status.toLowerCase()}`);
      await c.query("update ops.support_cases set status = 'REJECTED', closed_by = $2, closed_reason = $3, updated_at = now() where id = $1", [id, actor, reason]);
      await c.query("update identity.devices set status = 'revoked' where uid = $1 and public_key = $2 and status = 'pending'", [row.uid, row.new_public_key]);
      await notify(c, row.uid, 'SUPPORT_CASE_REJECTED', id, true);
      await this.audit(c, actor, 'support_case.reject', id, { reason });
      return { uid: row.uid, result: { id, status: 'REJECTED' } };
    });
    await publishUserEvents(this.redis, [{ uid: out.uid, kind: 'account', id, status: 'SUPPORT_CASE_REJECTED' }]);
    return out.result;
  }

  async activateCompleted(limit = 10): Promise<number> {
    if (!this.identity) return 0;
    const done = await this.pool.query<{ id: string; uid: string; new_phone_e164: string | null }>(
      `select s.id, s.uid, s.new_phone_e164 from ops.support_cases s join ops.recoveries r on r.id = s.recovery_id
        where s.status = 'SUBMITTED' and s.activated_at is null and r.status = 'COMPLETED' order by s.created_at limit $1`,
      [limit],
    );
    let activated = 0;
    for (const row of done.rows) {
      try {
        if (row.new_phone_e164) await this.identity.replacePhoneFactor(row.uid, row.new_phone_e164);
        await this.identity.revokeSessions(row.uid);
      } catch {
        await withTx(this.pool, (c) => this.audit(c, 'system', 'support_case.activate', row.id, { reason: 'identity_update_failed' }, 'FAILED'));
        continue;
      }
      await withTx(this.pool, async (c) => {
        let phone = 'unchanged';
        if (row.new_phone_e164) {
          await c.query('savepoint phone');
          try {
            await c.query('update identity.users set phone_e164 = $2, phone_verified_at = now(), updated_at = now() where uid = $1', [row.uid, row.new_phone_e164]);
            phone = 'verified';
          } catch (err) {
            if ((err as { code?: string }).code !== '23505') throw err;
            await c.query('rollback to savepoint phone');
            await c.query('update identity.users set phone_e164 = $2, phone_verified_at = null, updated_at = now() where uid = $1', [row.uid, row.new_phone_e164]);
            phone = 'set_unverified_duplicate';
          }
        }
        await c.query('update ops.support_cases set activated_at = now(), updated_at = now() where id = $1 and activated_at is null', [row.id]);
        await notify(c, row.uid, 'SUPPORT_CASE_COMPLETED', row.id, true);
        await this.audit(c, 'system', 'support_case.activate', row.id, { phone, sessions_revoked: true });
      });
      activated++;
    }
    return activated;
  }

  async submitDue(limit = 10): Promise<number> {
    if (!this.guardian) return 0;
    const due = await this.pool.query<{ id: string }>(
      `select s.id from ops.support_cases s
        where s.status = 'APPROVED' and s.recovery_id is null and s.created_at <= to_timestamp($1 / 1000.0) - make_interval(hours => $2)
          and not exists (select 1 from ops.recoveries r where r.support_case_id = s.id and r.status = 'FAILED' and r.updated_at > now() - $3::interval)
        order by s.created_at limit $4`,
      [this.now(), SUPPORT_REVIEW_HOURS, RETRY_AFTER_REFUSAL, limit],
    );
    let submitted = 0;
    for (const { id } of due.rows) if (await this.submit(id)) submitted++;
    return submitted;
  }

  private async submit(id: string): Promise<boolean> {
    const created = await withTx(this.pool, async (c) => {
      const row = await this.lock(c, id);
      if (row.status !== 'APPROVED' || row.recovery_id) return null;
      const busy = await c.query("select 1 from ops.recoveries where uid = $1 and status in ('REQUESTED', 'SIGNED', 'SUBMITTED', 'PENDING_TIMELOCK', 'CANCEL_REQUESTED')", [row.uid]);
      if (busy.rowCount) return null;
      const r = await c.query<{ id: string }>(
        "insert into ops.recoveries(uid, account_id, new_public_key, status, method, support_case_id) values ($1, $2, $3, 'REQUESTED', 'SUPPORT', $4) returning id",
        [row.uid, row.account_id, row.new_public_key, id],
      );
      await c.query('update ops.support_cases set recovery_id = $2, updated_at = now() where id = $1', [id, r.rows[0]!.id]);
      return { recoveryId: r.rows[0]!.id, uid: row.uid };
    });
    if (!created) return false;
    let result: SupportGuardianResponse;
    try {
      result = await this.guardian!.supportRecovery(created.recoveryId);
    } catch {
      result = { ok: false, reason: 'guardian_unavailable' };
    }
    return withTx(this.pool, async (c) => {
      if (!result.ok || !/^\d{1,20}$/.test(result.guardianNonce) || !/^[A-Za-z0-9+/]{86}==$/.test(result.signature)) {
        const reason = (result.ok ? 'guardian_response_invalid' : result.reason).slice(0, 200);
        await c.query("update ops.recoveries set status = 'FAILED', reason = $2, updated_at = now() where id = $1 and status = 'REQUESTED'", [created.recoveryId, reason]);
        await c.query('update ops.support_cases set recovery_id = null, updated_at = now() where id = $1', [id]);
        await this.audit(c, 'system', 'support_case.guardian', id, { recovery_id: created.recoveryId, reason }, 'DENIED');
        return false;
      }
      await c.query("update ops.recoveries set status = 'SIGNED', guardian_sig = $2, guardian_nonce = $3, updated_at = now() where id = $1 and status = 'REQUESTED'", [created.recoveryId, result.signature, result.guardianNonce]);
      await c.query("update ops.support_cases set status = 'SUBMITTED', updated_at = now() where id = $1", [id]);
      await c.query("insert into infra.outbox(topic, payload) values ('recovery.submit', $1)", [JSON.stringify({ recovery_id: created.recoveryId })]);
      await notify(c, created.uid, 'RECOVERY_REQUESTED', created.recoveryId, true);
      await this.audit(c, 'system', 'support_case.guardian', id, { recovery_id: created.recoveryId });
      return true;
    });
  }
}
