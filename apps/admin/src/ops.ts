import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { withTx } from '@obiba/db';
import { KILL_SWITCHES, SANDBOX_CURRENCY, SANDBOX_DECIMALS, USDC_DECIMALS, killSwitchKey } from '@obiba/domain';
import { AdminError } from './admin';
import { ROLES, type StaffRole } from './config';

export type HealthState = 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'STALE' | 'UNKNOWN' | 'NOT_CONFIGURED';

export interface Signal {
  key: string;
  label: string;
  state: HealthState;
  summary: string;
  source: string;
  observedAt: string | null;
  href: string | null;
}

export interface WatchAccount {
  account: string;
  label: string;
  minNear: string;
}

export interface OpsSettings {
  entity: string;
  network: 'testnet' | 'mainnet' | null;
  rpcUrl: string | null;
  guardianUrl: string | null;
  identityProject: string | null;
  release: string | null;
  watchAccounts: WatchAccount[];
  staff: Map<string, StaffRole>;
}

export const ASSETS: Record<string, { decimals: number; label: string; domain: 'REAL' | 'DEMO' }> = {
  USDC: { decimals: USDC_DECIMALS, label: 'USDC', domain: 'REAL' },
  [SANDBOX_CURRENCY]: { decimals: SANDBOX_DECIMALS, label: 'Local services balance', domain: 'DEMO' },
};

const TX_TYPES = ['transfer', 'invoice_pay', 'deposit', 'withdrawal', 'invoice_deposit', 'local', 'onchain'] as const;
export type TxType = (typeof TX_TYPES)[number];
const PHASES = ['completed', 'pending', 'failed', 'review', 'unknown', 'refunded'] as const;
const WINDOWS: Record<string, { interval: string; bucket: 'hour' | 'day'; points: number }> = {
  '24h': { interval: '24 hours', bucket: 'hour', points: 24 },
  '7d': { interval: '7 days', bucket: 'day', points: 7 },
  '30d': { interval: '30 days', bucket: 'day', points: 30 },
};
const RECON_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 3 * RECON_INTERVAL_MS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OP_ID = /^[0-9a-f]{32}$/;
const UID = /^[A-Za-z0-9_-]{6,128}$/;
const REASON = /^[\x20-\x7e]{8,300}$/;

const PHASE_SQL = `case
  when status in ('SETTLED', 'CREDITED', 'COMPLETED', 'SUCCEEDED') then 'completed'
  when status in ('REVIEW_REQUIRED', 'REVIEW', 'INCOMPLETE') then 'review'
  when status = 'UNKNOWN' then 'unknown'
  when status = 'REFUNDED' then 'refunded'
  when status in ('EXPIRED', 'REJECTED', 'FAILED', 'CANCELLED') then 'failed'
  else 'pending' end`;

const TX_SQL = `
  select case when p.kind = 'PayInvoice' then 'invoice_pay' else 'transfer' end as type, p.op_id as id, p.uid, p.account_id, p.status,
         p.amount::text as amount, 'USDC' as currency, p.receiver as counterparty,
         nullif(array_to_string(p.relay_tx_hashes, ' '), '') as reference, 'NEAR' as rail, p.created_at, p.updated_at,
         p.op_id || ' ' || p.receiver || ' ' || array_to_string(p.relay_tx_hashes, ' ') || ' ' || coalesce(p.invoice_id, '') as blob
    from ops.prepared_ops p where not exists (select 1 from ops.withdrawals w where w.op_id = p.op_id)
  union all
  select 'deposit', d.id::text, d.uid, d.account_id, d.status, d.min_amount_out::text, 'USDC', d.origin_asset,
         coalesce(d.correlation_id, d.deposit_address), 'NEAR Intents', d.created_at, d.updated_at,
         d.id::text || ' ' || d.deposit_address || ' ' || coalesce(d.correlation_id, '') || ' ' || d.tx_hashes::text
    from ops.deposits d
  union all
  select 'withdrawal', w.id::text, w.uid, w.account_id, w.status, w.amount_in::text, 'USDC', w.destination || ' ' || w.recipient,
         w.deposit_address, 'NEAR Intents', w.created_at, w.updated_at,
         w.id::text || ' ' || w.op_id || ' ' || w.deposit_address || ' ' || w.recipient || ' ' || w.tx_hashes::text
    from ops.withdrawals w
  union all
  select 'invoice_deposit', x.id::text, i.merchant_uid, i.merchant_account, x.status, i.amount::text, 'USDC', x.origin_asset,
         x.deposit_address, 'NEAR Intents', x.created_at, x.updated_at,
         x.id::text || ' ' || x.invoice_id || ' ' || x.deposit_address || ' ' || x.tx_hashes::text
    from ops.invoice_deposits x join ops.invoices i on i.invoice_id = x.invoice_id
  union all
  select 'local', s.id::text, s.uid, a.account_id, s.status, s.amount::text,
         case when s.funding = 'REAL_INTERNAL' then 'USDC' else '${SANDBOX_CURRENCY}' end, s.kind || ' ' || s.provider,
         s.receipt->>'provider_ref', 'Pilot rail', s.created_at, s.updated_at,
         s.id::text || ' ' || coalesce(s.receipt->>'provider_ref', '') || ' ' || coalesce(s.receipt->>'ref', '') || ' ' || coalesce(s.op_id, '')
    from ops.sandbox_ops s left join chain.accounts a on a.uid = s.uid
  union all
  select 'onchain', e.receipt_id || ':' || e.log_index || case when a.account_id = e.to_account then ':in' else ':out' end, a.uid, a.account_id, 'SETTLED',
         e.amount::text, 'USDC', case when a.account_id = e.to_account then 'From ' || e.from_account else 'To ' || e.to_account end,
         e.tx_hash, 'NEAR', e.observed_at, e.observed_at,
         e.receipt_id || ' ' || coalesce(e.tx_hash, '') || ' ' || e.from_account || ' ' || e.to_account
    from chain.events e join chain.accounts a on a.account_id = e.to_account or a.account_id = e.from_account
   where not exists (select 1 from ops.prepared_ops p where e.tx_hash = any(p.relay_tx_hashes))
     and not exists (select 1 from ops.deposits d where d.credited_event->>'receipt_id' = e.receipt_id)`;

function iso(v: Date | string | null | undefined): string | null {
  return v ? new Date(v).toISOString() : null;
}

function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, user.length - 1)))}@${domain}`;
}

function maskPhone(phone: string): string {
  return `${phone.slice(0, 4)} •• ••• ${phone.slice(-4)}`;
}

function encodeCursor(at: Date | string, id: string): string {
  return Buffer.from(JSON.stringify([new Date(at).toISOString(), id])).toString('base64url');
}

function decodeCursor(raw: unknown): [string, string] | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new AdminError(400, 'invalid cursor');
  }
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && !Number.isNaN(Date.parse(v[0])) && v[1].length <= 64) return [v[0], v[1]];
  throw new AdminError(400, 'invalid cursor');
}

function limitOf(raw: unknown, fallback = 50, max = 100): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : fallback;
  return Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : fallback;
}

function search(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 200 || !/^[\x20-\x7e]+$/.test(raw)) throw new AdminError(400, 'invalid search');
  return raw.trim() || null;
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) throw new AdminError(400, 'invalid filter');
  return raw as T;
}

function timeOf(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) throw new AdminError(400, 'invalid time');
  return new Date(raw).toISOString();
}

function reason(raw: unknown): string {
  if (typeof raw !== 'string' || !REASON.test(raw.trim())) throw new AdminError(400, 'a reason of 8-300 printable characters is required');
  return raw.trim();
}

function sanitizeError(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') return 'Unspecified error';
  const first = raw.split('\n')[0] ?? '';
  return first
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[0-9a-f]{24,}\b/gi, '<id>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<id>')
    .slice(0, 120);
}

interface IncidentRow {
  id: string;
  title: string;
  severity: string;
  status: string;
  summary: string;
  signal_key: string | null;
  resources: string[];
  owner: string | null;
  declared_by: string;
  acknowledged_by: string | null;
  acknowledged_at: Date | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution: string | null;
  created_at: Date;
  updated_at: Date;
}

function incidentOut(i: IncidentRow) {
  return {
    id: i.id,
    title: i.title,
    severity: i.severity,
    status: i.status,
    summary: i.summary,
    signalKey: i.signal_key,
    resources: i.resources,
    owner: i.owner,
    declaredBy: i.declared_by,
    createdAt: iso(i.created_at),
    acknowledgedAt: iso(i.acknowledged_at),
    acknowledgedBy: i.acknowledged_by,
    resolvedAt: iso(i.resolved_at),
    resolvedBy: i.resolved_by,
    resolution: i.resolution,
    updatedAt: iso(i.updated_at),
  };
}

function text(raw: unknown, min: number, max: number, field: string): string {
  if (typeof raw !== 'string') throw new AdminError(400, `${field} is required`);
  const v = raw.trim();
  if (v.length < min || v.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) throw new AdminError(400, `${field} must be ${min}-${max} characters`);
  return v;
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export class OpsService {
  private probeCache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
    private readonly settings: OpsSettings,
  ) {}

  private async record(actor: string, action: string, target: string, details: Record<string, unknown>) {
    await this.pool.query("insert into audit.log(actor, action, target, outcome, details) values ($1, $2, $3, 'ALLOWED', $4)", [`staff:${actor}`, action, target, JSON.stringify(details)]);
  }

  private async cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.probeCache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const value = await fn();
    this.probeCache.set(key, { at: Date.now(), value });
    return value;
  }

  private async rpc<T>(method: string, params: unknown): Promise<{ result: T; latencyMs: number } | null> {
    if (!this.settings.rpcUrl) return null;
    const started = Date.now();
    try {
      const res = await fetch(this.settings.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'ops', method, params }),
        signal: AbortSignal.timeout(3_000),
        redirect: 'error',
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { result?: T };
      return body.result === undefined ? null : { result: body.result, latencyMs: Date.now() - started };
    } catch {
      return null;
    }
  }

  private chainHead() {
    return this.cached('head', 15_000, async () => {
      const r = await this.rpc<{ header: { height: number; timestamp_nanosec: string } }>('block', { finality: 'final' });
      return r ? { height: r.result.header.height, at: new Date(Number(BigInt(r.result.header.timestamp_nanosec) / 1_000_000n)).toISOString(), latencyMs: r.latencyMs, observedAt: new Date().toISOString() } : null;
    });
  }

  private guardianProbe() {
    return this.cached('guardian', 15_000, async () => {
      if (!this.settings.guardianUrl) return null;
      const started = Date.now();
      try {
        const res = await fetch(`${this.settings.guardianUrl}/healthz`, { signal: AbortSignal.timeout(3_000), redirect: 'error' });
        return { ok: res.ok, status: res.status, latencyMs: Date.now() - started, observedAt: new Date().toISOString() };
      } catch {
        return { ok: false, status: 0, latencyMs: Date.now() - started, observedAt: new Date().toISOString() };
      }
    });
  }

  private async watchedBalances() {
    return this.cached('watch', 30_000, async () =>
      Promise.all(
        this.settings.watchAccounts.map(async (w) => {
          const r = await this.rpc<{ amount: string; locked: string }>('query', { request_type: 'view_account', finality: 'final', account_id: w.account });
          return { ...w, amount: r?.result.amount ?? null, observedAt: r ? new Date().toISOString() : null };
        }),
      ),
    );
  }

  private async killSwitchState() {
    const out: { name: string; active: boolean; expiresInSeconds: number | null }[] = [];
    try {
      for (const name of KILL_SWITCHES) {
        const ttl = await this.redis.pttl(killSwitchKey(name));
        out.push({ name, active: ttl > 0 || ttl === -1, expiresInSeconds: ttl > 0 ? Math.ceil(ttl / 1000) : null });
      }
      return { ok: true as const, switches: out };
    } catch {
      return { ok: false as const, switches: [] };
    }
  }

  private async queues() {
    const names = ['obiba-main', 'obiba-ingest'];
    try {
      const rows = await Promise.all(
        names.map(async (q) => {
          const k = (s: string) => `bull:${q}:${s}`;
          const [wait, active, delayed, failed, prioritized, lastDone, lastFail] = await Promise.all([
            this.redis.llen(k('wait')),
            this.redis.llen(k('active')),
            this.redis.zcard(k('delayed')),
            this.redis.zcard(k('failed')),
            this.redis.zcard(k('prioritized')),
            this.redis.zrevrange(k('completed'), 0, 0, 'WITHSCORES'),
            this.redis.zrevrange(k('failed'), 0, 9, 'WITHSCORES'),
          ]);
          const failures: { job: string; at: string | null; error: string; attempts: number }[] = [];
          for (let i = 0; i < lastFail.length; i += 2) {
            const job = lastFail[i]!;
            const h = await this.redis.hmget(k(job), 'name', 'failedReason', 'attemptsMade', 'finishedOn');
            failures.push({ job: h[0] ?? 'job', at: h[3] ? new Date(Number(h[3])).toISOString() : iso(new Date(Number(lastFail[i + 1]))), error: sanitizeError(h[1]), attempts: Number(h[2] ?? 0) });
          }
          return {
            queue: q,
            waiting: wait + prioritized,
            active,
            delayed,
            failed,
            lastCompletedAt: lastDone[1] ? new Date(Number(lastDone[1])).toISOString() : null,
            failures,
          };
        }),
      );
      let workers: number | null = null;
      try {
        const list = (await this.redis.client('LIST')) as string;
        const n = list.split('\n').filter((l) => / name=bull:[^ ]+:w:/.test(l) || / name=bull:[A-Za-z0-9+/=]+ /.test(l)).length;
        workers = n > 0 ? n : null;
      } catch {
        workers = null;
      }
      return { ok: true as const, observedAt: new Date().toISOString(), queues: rows, workerConnections: workers };
    } catch {
      return { ok: false as const, observedAt: new Date().toISOString(), queues: [], workerConnections: null };
    }
  }

  async session(email: string, role: StaffRole) {
    const now = (await this.pool.query<{ now: Date }>('select now()')).rows[0]!.now;
    return {
      email,
      role,
      entity: this.settings.entity,
      network: this.settings.network,
      release: this.settings.release,
      serverTime: iso(now),
      capabilities: capabilitiesFor(role),
    };
  }

  async overview(window: unknown) {
    const w = WINDOWS[typeof window === 'string' ? window : '24h'];
    if (!w) throw new AdminError(400, 'invalid window');
    const [now, volume, series, phases, holds, outbox, recon, review, ingest, killSwitches, head, guardian, queues] = await Promise.all([
      this.pool.query<{ now: Date }>('select now()').then((r) => r.rows[0]!.now),
      this.pool.query<{ currency: string; inflow: string; outflow: string; journals: string }>(
        `select e.currency, coalesce(sum(e.amount) filter (where e.amount > 0), 0)::text as inflow, coalesce(-sum(e.amount) filter (where e.amount < 0), 0)::text as outflow,
                count(distinct j.id)::text as journals
           from ledger.entries e join ledger.journals j on j.id = e.journal_id join ledger.accounts a on a.id = e.account_id
          where j.domain = 'REAL' and a.kind = 'WALLET' and j.created_at > now() - $1::interval
          group by e.currency order by e.currency`,
        [w.interval],
      ),
      this.pool.query<{ bucket: Date; inflow: string; outflow: string }>(
        `with b as (select generate_series(date_trunc($1::text, now()) - ($2::int - 1) * ('1 ' || $1::text)::interval, date_trunc($1::text, now()), ('1 ' || $1::text)::interval) as bucket)
         select b.bucket, coalesce(sum(e.amount) filter (where e.amount > 0), 0)::text as inflow, coalesce(-sum(e.amount) filter (where e.amount < 0), 0)::text as outflow
           from b left join ledger.journals j on j.domain = 'REAL' and date_trunc($1::text, j.created_at) = b.bucket
                  left join ledger.entries e on e.journal_id = j.id and e.currency = 'USDC' and e.account_id in (select id from ledger.accounts where kind = 'WALLET')
          group by b.bucket order by b.bucket`,
        [w.bucket, w.points],
      ),
      this.pool.query<{ phase: string; currency: string; n: string; amount: string }>(
        `select ${PHASE_SQL} as phase, currency, count(*)::text as n, sum(amount::numeric)::text as amount
           from (${TX_SQL}) t where created_at > now() - $1::interval group by 1, 2`,
        [w.interval],
      ),
      this.pool.query<{ active: string; amount: string | null; oldest: Date | null; expired: string }>(
        `select count(*)::text as active, sum(amount)::text as amount, min(created_at) as oldest, count(*) filter (where expires_at < now())::text as expired
           from ledger.holds where status = 'ACTIVE'`,
      ),
      this.pool.query<{ pending: string; oldest: Date | null; dispatched: string }>(
        `select count(*) filter (where dispatched_at is null)::text as pending, min(created_at) filter (where dispatched_at is null) as oldest,
                count(*) filter (where dispatched_at > now() - $1::interval)::text as dispatched from infra.outbox`,
        [w.interval],
      ),
      this.reconLatest(),
      this.pool.query<{ type: string; n: string; oldest: Date | null }>(
        `select type, count(*)::text as n, min(updated_at) as oldest from (
           select 'deposit' as type, updated_at from ops.deposits where status = 'REVIEW_REQUIRED'
           union all select 'withdrawal', updated_at from ops.withdrawals where status = 'REVIEW_REQUIRED'
           union all select 'invoice_payment', updated_at from ops.invoice_deposits where status = 'REVIEW_REQUIRED'
           union all select 'local', updated_at from ops.sandbox_ops where status = 'REVIEW'
           union all select 'unknown_outcome', updated_at from ops.prepared_ops where status = 'UNKNOWN'
           union all select 'support', updated_at from ops.support_cases where status in ('OPEN', 'VERIFIED', 'APPROVED')
         ) q group by type`,
      ),
      this.pool.query<{ height: string | null; last_event: Date | null }>(
        "select (select block_height::text from chain.cursor where stream = 'blocks') as height, (select max(observed_at) from chain.events) as last_event",
      ),
      this.killSwitchState(),
      this.chainHead(),
      this.guardianProbe(),
      this.queues(),
    ]);

    const counts = Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<(typeof PHASES)[number], number>;
    const valueByCurrency: Record<string, Record<string, string>> = {};
    for (const r of phases.rows) {
      counts[r.phase as (typeof PHASES)[number]] += Number(r.n);
      (valueByCurrency[r.currency] ??= {})[r.phase] = r.amount;
    }
    const decided = counts.completed + counts.failed;
    const reviewByType = Object.fromEntries(review.rows.map((r) => [r.type, { count: Number(r.n), oldest: iso(r.oldest) }]));
    const reviewTotal = review.rows.filter((r) => r.type !== 'unknown_outcome').reduce((s, r) => s + Number(r.n), 0);
    const oldestReview = review.rows.filter((r) => r.type !== 'unknown_outcome').map((r) => r.oldest).filter((x): x is Date => !!x).sort((a, b) => +a - +b)[0] ?? null;
    const h = holds.rows[0]!;
    const o = outbox.rows[0]!;
    const nowMs = new Date(now).getTime();
    const nowIso = iso(now)!;

    const signals: Signal[] = [];
    const reconAt = recon.lastCheckedAt ? Date.parse(recon.lastCheckedAt) : null;
    signals.push({
      key: 'reconciliation',
      label: 'Chain reconciliation',
      state: reconAt === null ? 'UNKNOWN' : nowMs - reconAt > STALE_AFTER_MS ? 'STALE' : recon.mismatched > 0 ? 'CRITICAL' : 'HEALTHY',
      summary:
        reconAt === null
          ? 'No reconciliation run has been recorded'
          : recon.mismatched > 0
            ? `${recon.mismatched} of ${recon.accounts} account balances do not match the chain`
            : `${recon.accounts} account balances matched the chain`,
      source: 'ops.reconciliation_runs',
      observedAt: recon.lastCheckedAt,
      href: '/ledger?tab=reconciliation',
    });
    const outboxAge = o.oldest ? nowMs - new Date(o.oldest).getTime() : 0;
    signals.push({
      key: 'outbox',
      label: 'Job dispatch',
      state: Number(o.pending) === 0 ? 'HEALTHY' : outboxAge > 15 * 60_000 ? 'CRITICAL' : outboxAge > 2 * 60_000 ? 'WARNING' : 'HEALTHY',
      summary: Number(o.pending) === 0 ? 'No undispatched jobs' : `${o.pending} undispatched, oldest ${Math.round(outboxAge / 60_000)} min`,
      source: 'infra.outbox',
      observedAt: nowIso,
      href: '/jobs',
    });
    const failedJobs = queues.queues.reduce((s, q) => s + q.failed, 0);
    signals.push({
      key: 'workers',
      label: 'Background workers',
      state: !queues.ok ? 'UNKNOWN' : queues.workerConnections === null ? 'UNKNOWN' : failedJobs > 0 ? 'WARNING' : 'HEALTHY',
      summary: !queues.ok
        ? 'Queue store unreachable'
        : queues.workerConnections === null
          ? 'No worker connection is visible; heartbeats are not published'
          : `${queues.workerConnections} worker connections${failedJobs ? `, ${failedJobs} failed jobs retained` : ''}`,
      source: 'Redis queues',
      observedAt: queues.observedAt,
      href: '/jobs',
    });
    const cursor = ingest.rows[0]?.height ? Number(ingest.rows[0].height) : null;
    const lag = head && cursor !== null ? head.height - cursor : null;
    signals.push({
      key: 'indexer',
      label: 'Chain indexer',
      state: !this.settings.rpcUrl ? (cursor === null ? 'UNKNOWN' : 'UNKNOWN') : head === null ? 'UNKNOWN' : cursor === null ? 'UNKNOWN' : lag! > 600 ? 'CRITICAL' : lag! > 120 ? 'STALE' : 'HEALTHY',
      summary:
        cursor === null
          ? 'No block cursor recorded'
          : lag === null
            ? `At block ${cursor.toLocaleString('en-US')}; chain head not observed`
            : `${lag.toLocaleString('en-US')} blocks behind final head`,
      source: this.settings.rpcUrl ? 'chain.cursor and NEAR RPC' : 'chain.cursor',
      observedAt: head?.observedAt ?? null,
      href: '/providers',
    });
    signals.push({
      key: 'guardian',
      label: 'Guardian co-signer',
      state: guardian === null ? 'NOT_CONFIGURED' : guardian.ok ? 'HEALTHY' : 'CRITICAL',
      summary: guardian === null ? 'Guardian address is not configured for this console' : guardian.ok ? `Responding in ${guardian.latencyMs} ms` : 'Health check failed',
      source: 'Guardian health endpoint',
      observedAt: guardian?.observedAt ?? null,
      href: '/providers',
    });
    const active = killSwitches.switches.filter((k) => k.active);
    signals.push({
      key: 'controls',
      label: 'Processing controls',
      state: !killSwitches.ok ? 'UNKNOWN' : active.length ? 'WARNING' : 'HEALTHY',
      summary: !killSwitches.ok ? 'Control store unreachable' : active.length ? `Paused: ${active.map((k) => k.name).join(', ')}` : 'All processing enabled',
      source: 'Redis kill switches',
      observedAt: nowIso,
      href: '/settings',
    });
    signals.push({
      key: 'liquidity',
      label: 'Liquidity',
      state: this.settings.watchAccounts.length === 0 ? 'NOT_CONFIGURED' : 'UNKNOWN',
      summary: this.settings.watchAccounts.length === 0 ? 'No operating accounts are configured for monitoring' : 'See Treasury',
      source: 'NEAR RPC view_account',
      observedAt: null,
      href: '/treasury',
    });
    if (this.settings.watchAccounts.length) {
      const balances = await this.watchedBalances();
      const low = balances.filter((b) => b.amount !== null && BigInt(b.amount) < BigInt(b.minNear));
      const unseen = balances.filter((b) => b.amount === null);
      const last = signals[signals.length - 1]!;
      last.state = unseen.length === balances.length ? 'UNKNOWN' : low.length ? 'CRITICAL' : unseen.length ? 'WARNING' : 'HEALTHY';
      last.summary = low.length ? `Below threshold: ${low.map((b) => b.label).join(', ')}` : unseen.length ? `${unseen.length} account balances not observed` : `${balances.length} operating accounts above threshold`;
      last.observedAt = balances.find((b) => b.observedAt)?.observedAt ?? null;
    }
    signals.push({ key: 'backups', label: 'Backups', state: 'NOT_CONFIGURED', summary: 'Backup attestations are not reported to this console', source: 'Recovery attestations', observedAt: null, href: '/settings?tab=recovery' });
    signals.push({ key: 'alerts', label: 'Alert delivery', state: 'NOT_CONFIGURED', summary: 'No external alert channel reports delivery to this console', source: 'Alert delivery records', observedAt: null, href: '/cases?tab=incidents' });

    const attention: { key: string; severity: 'CRITICAL' | 'HIGH' | 'MEDIUM'; title: string; detail: string; count: number; since: string | null; href: string }[] = [];
    if (recon.mismatched > 0) attention.push({ key: 'mismatch', severity: 'CRITICAL', title: 'Ledger does not match the chain', detail: `${recon.mismatched} account balances differ from on-chain balances`, count: recon.mismatched, since: recon.oldestMismatch, href: '/ledger?tab=reconciliation' });
    const unknown = reviewByType.unknown_outcome;
    if (unknown) attention.push({ key: 'unknown', severity: 'HIGH', title: 'Unknown transaction outcomes', detail: 'Submitted but not yet proven settled or failed. Do not resend.', count: unknown.count, since: unknown.oldest, href: '/transactions?phase=unknown' });
    if (Number(h.expired) > 0) attention.push({ key: 'holds', severity: 'HIGH', title: 'Holds past their expiry', detail: 'Reserved funds whose operation has not closed the hold', count: Number(h.expired), since: iso(h.oldest), href: '/ledger?tab=holds' });
    if (reviewTotal > 0) attention.push({ key: 'review', severity: 'MEDIUM', title: 'Cases awaiting review', detail: Object.entries(reviewByType).filter(([k]) => k !== 'unknown_outcome').map(([k, v]) => `${v.count} ${k.replace('_', ' ')}`).join(', '), count: reviewTotal, since: iso(oldestReview), href: '/cases' });
    if (failedJobs > 0) attention.push({ key: 'jobs', severity: 'MEDIUM', title: 'Failed background jobs', detail: 'Retained failures in the job queues', count: failedJobs, since: queues.queues.flatMap((q) => q.failures.map((f) => f.at)).filter((x): x is string => !!x).sort()[0] ?? null, href: '/jobs' });
    if (signals.find((s) => s.key === 'reconciliation')?.state === 'STALE') attention.push({ key: 'recon-stale', severity: 'HIGH', title: 'Reconciliation is stale', detail: 'No reconciliation run in the last 3 minutes. Balances are unverified.', count: 1, since: recon.lastCheckedAt, href: '/ledger?tab=reconciliation' });

    return {
      observedAt: nowIso,
      window: typeof window === 'string' ? window : '24h',
      bucket: w.bucket,
      performance: {
        counts,
        completionRate: decided === 0 ? null : counts.completed / decided,
        completionFormula: 'completed / (completed + failed); pending, review, unknown and refunded are excluded',
        valueByCurrency,
        volume: volume.rows.map((r) => ({ currency: r.currency, inflow: r.inflow, outflow: r.outflow, journals: Number(r.journals) })),
        series: series.rows.map((r) => ({ at: iso(r.bucket)!, inflow: r.inflow, outflow: r.outflow })),
        source: 'ledger.entries on REAL customer accounts; operation tables for counts',
      },
      holds: { active: Number(h.active), amount: h.amount ?? '0', oldest: iso(h.oldest), expired: Number(h.expired) },
      outbox: { pending: Number(o.pending), oldest: iso(o.oldest), dispatched: Number(o.dispatched) },
      signals,
      attention,
      assets: ASSETS,
    };
  }

  private async reconLatest() {
    const r = await this.pool.query<{ account_id: string; token: string; ledger_posted: string; chain_balance: string; matched: boolean; checked_at: Date; first_mismatch: Date | null; runs: string }>(
      `select distinct on (account_id) account_id, token, ledger_posted::text, chain_balance::text, matched, checked_at,
              (select min(r2.checked_at) from ops.reconciliation_runs r2 where r2.account_id = r.account_id and not r2.matched
                 and r2.checked_at > coalesce((select max(r3.checked_at) from ops.reconciliation_runs r3 where r3.account_id = r.account_id and r3.matched), '-infinity')) as first_mismatch,
              (select count(*) from ops.reconciliation_runs r4 where r4.account_id = r.account_id)::text as runs
         from ops.reconciliation_runs r order by account_id, checked_at desc`,
    );
    const rows = r.rows.map((x) => ({
      accountId: x.account_id,
      tokens: x.token.split(','),
      ledgerPosted: x.ledger_posted,
      chainBalance: x.chain_balance,
      difference: (BigInt(x.chain_balance) - BigInt(x.ledger_posted)).toString(),
      matched: x.matched,
      checkedAt: iso(x.checked_at)!,
      mismatchSince: x.matched ? null : iso(x.first_mismatch ?? x.checked_at),
      runs: Number(x.runs),
    }));
    const mismatches = rows.filter((x) => !x.matched);
    return {
      rows,
      accounts: rows.length,
      mismatched: mismatches.length,
      lastCheckedAt: rows.map((x) => x.checkedAt).sort().at(-1) ?? null,
      oldestMismatch: mismatches.map((x) => x.mismatchSince!).sort()[0] ?? null,
    };
  }

  async transactions(query: Record<string, unknown>, role: StaffRole) {
    const q = search(query.q);
    const type = oneOf(query.type, TX_TYPES);
    const phase = oneOf(query.phase, PHASES);
    const currency = oneOf(query.currency, Object.keys(ASSETS));
    const from = timeOf(query.from);
    const to = timeOf(query.to);
    const uid = typeof query.uid === 'string' && query.uid ? (UID.test(query.uid) ? query.uid : (() => { throw new AdminError(400, 'invalid customer'); })()) : null;
    const cursor = decodeCursor(query.cursor);
    const limit = limitOf(query.limit);
    const contact = ROLES.indexOf(role) >= ROLES.indexOf('operator');
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (type) where.push(`t.type = ${p(type)}`);
    if (phase) where.push(`t.phase = ${p(phase)}`);
    if (currency) where.push(`t.currency = ${p(currency)}`);
    if (from) where.push(`t.created_at >= ${p(from)}`);
    if (to) where.push(`t.created_at < ${p(to)}`);
    if (uid) where.push(`t.uid = ${p(uid)}`);
    if (q) {
      const exact = p(q);
      const like = p(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      const handle = p(q.replace(/^@/, '').toLowerCase());
      const parts = [`t.id = ${exact}`, `t.uid = ${exact}`, `t.account_id = ${exact}`, `t.blob ilike ${like}`, `u.handle = ${handle}`, `u.account_name = ${handle}`];
      if (contact) parts.push(`lower(u.email) = lower(${exact})`, `u.phone_e164 = ${exact}`);
      where.push(`(${parts.join(' or ')})`);
    }
    if (cursor) where.push(`(t.created_at, t.id) < (${p(cursor[0])}::timestamptz, ${p(cursor[1])})`);
    const sql = `select t.*, u.display_name, u.handle from (select x.*, ${PHASE_SQL} as phase from (${TX_SQL}) x) t
                 left join identity.users u on u.uid = t.uid
                 ${where.length ? `where ${where.join(' and ')}` : ''}
                 order by t.created_at desc, t.id desc limit ${p(limit + 1)}`;
    const r = await this.pool.query<{ type: TxType; id: string; uid: string | null; account_id: string | null; status: string; phase: string; amount: string; currency: string; counterparty: string; reference: string | null; rail: string; created_at: Date; updated_at: Date; display_name: string | null; handle: string | null }>(sql, params);
    const rows = r.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      observedAt: new Date().toISOString(),
      rows: rows.map((x) => ({
        type: x.type,
        id: x.id,
        uid: x.uid,
        accountId: x.account_id,
        customer: x.display_name,
        handle: x.handle,
        status: x.status,
        phase: x.phase,
        amount: x.amount,
        currency: x.currency,
        counterparty: x.counterparty,
        reference: x.reference,
        rail: x.rail,
        createdAt: iso(x.created_at),
        updatedAt: iso(x.updated_at),
      })),
      nextCursor: r.rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  async transaction(rawType: string, id: string) {
    const type = oneOf(rawType, TX_TYPES);
    if (!type) throw new AdminError(400, 'invalid type');
    const idPattern = type === 'transfer' || type === 'invoice_pay' ? OP_ID : type === 'onchain' ? /^[1-9A-HJ-NP-Za-km-z]{32,64}:\d{1,5}:(in|out)$/ : UUID;
    if (!idPattern.test(id)) throw new AdminError(400, 'invalid id');
    const base = (await this.pool.query<Record<string, unknown> & { uid: string | null; account_id: string | null; status: string; created_at: Date; updated_at: Date; amount: string; currency: string; phase: string }>(
      `select t.*, ${PHASE_SQL} as phase from (${TX_SQL}) t where t.type = $1 and t.id = $2`,
      [type, id],
    )).rows[0];
    if (!base) throw new AdminError(404, 'transaction not found');

    let opId: string | null = type === 'transfer' || type === 'invoice_pay' ? id : null;
    let provider: { name: string; status: string | null; detail: Record<string, unknown> | null; updatedAt: string | null } = { name: 'None', status: null, detail: null, updatedAt: null };
    let raw: Record<string, unknown> = {};
    let txHashes: string[] = [];
    let journalRefs: string[] = [];
    const holdRefs: string[] = [];
    let settlementPolicy = '';
    let evidence: { source: string; verified: boolean; detail: string } | null = null;

    if (type === 'transfer' || type === 'invoice_pay') {
      const p = (await this.pool.query(`select op_id, kind, receiver, amount::text, needs_guardian, guardian_sig is not null as cosigned, status, relay_tx_hashes, relay_attempts, invoice_id, canonical->'op'->>'token' as token, expires_at_ns::text, created_at, updated_at from ops.prepared_ops where op_id = $1`, [id])).rows[0] as Record<string, unknown>;
      raw = p;
      txHashes = (p.relay_tx_hashes as string[]) ?? [];
      holdRefs.push(`op:${id}`);
      provider = { name: p.needs_guardian ? 'Guardian co-signer' : 'Device key (within daily limit)', status: p.needs_guardian ? (p.cosigned ? 'COSIGNED' : 'NOT_COSIGNED') : 'NOT_REQUIRED', detail: { relayAttempts: p.relay_attempts }, updatedAt: iso(p.updated_at as Date) };
      settlementPolicy = 'Settled only when the indexer observes the token transfer in a final NEAR block and posts the journal. A relay submission or timeout is not settlement.';
    } else if (type === 'deposit') {
      const d = (await this.pool.query(`select origin_asset, deposit_address, deposit_memo, amount_in, min_amount_out::text, correlation_id, status, credited_event, tx_hashes, quote->>'deadline' as deadline, created_at, updated_at from ops.deposits where id = $1`, [id])).rows[0] as Record<string, unknown>;
      raw = d;
      txHashes = Object.values((d.tx_hashes as Record<string, unknown>) ?? {}).flat().filter((x): x is string => typeof x === 'string');
      const ev = d.credited_event as { receipt_id?: string; log_index?: number; reason?: string } | null;
      if (ev?.receipt_id) journalRefs.push(`evt:${ev.receipt_id}:${ev.log_index ?? 0}`);
      provider = { name: 'NEAR Intents 1Click', status: String(d.status), detail: { originAsset: d.origin_asset, amountIn: d.amount_in, depositAddress: d.deposit_address, correlationId: d.correlation_id }, updatedAt: iso(d.updated_at as Date) };
      settlementPolicy = 'Credited only when a USDC transfer of at least the quoted minimum to the customer account is observed on NEAR and not already claimed by another deposit. Provider completion alone never credits.';
      evidence = ev ? { source: ev.receipt_id ? 'NEAR receipt' : 'Indexer', verified: !!ev.receipt_id, detail: ev.receipt_id ? `Receipt ${ev.receipt_id} log ${ev.log_index}` : ev.reason ?? 'No matching transfer' } : null;
    } else if (type === 'withdrawal') {
      const w = (await this.pool.query(`select op_id, destination, recipient, deposit_address, amount_in::text, amount_out, min_amount_out, status, tx_hashes, evidence, created_at, updated_at from ops.withdrawals where id = $1`, [id])).rows[0] as Record<string, unknown>;
      raw = w;
      opId = String(w.op_id);
      const op = (await this.pool.query<{ relay_tx_hashes: string[] }>('select relay_tx_hashes from ops.prepared_ops where op_id = $1', [opId])).rows[0];
      txHashes = [...(op?.relay_tx_hashes ?? []), ...Object.values((w.tx_hashes as Record<string, unknown>) ?? {}).flat().filter((x): x is string => typeof x === 'string')];
      holdRefs.push(`op:${opId}`);
      provider = { name: 'NEAR Intents 1Click', status: String(w.status), detail: { destination: w.destination, recipient: w.recipient, amountOut: w.amount_out, minAmountOut: w.min_amount_out }, updatedAt: iso(w.updated_at as Date) };
      settlementPolicy = 'Completed only with destination-chain transfer evidence to the recipient. 1Click acceptance or a NEAR send alone is not completion. Unknown outcomes stay open; they are never resent.';
      const e = w.evidence as Record<string, unknown> | null;
      evidence = e ? { source: 'Destination chain', verified: w.status === 'COMPLETED', detail: Object.entries(e).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('; ').slice(0, 300) } : null;
    } else if (type === 'invoice_deposit') {
      const x = (await this.pool.query(`select d.invoice_id, d.origin_asset, d.deposit_address, d.amount_in, d.refund_to, d.status, d.tx_hashes, i.status as invoice_status, i.reference, i.fee_bps, i.paid_event, d.created_at, d.updated_at from ops.invoice_deposits d join ops.invoices i on i.invoice_id = d.invoice_id where d.id = $1`, [id])).rows[0] as Record<string, unknown>;
      raw = x;
      txHashes = Object.values((x.tx_hashes as Record<string, unknown>) ?? {}).flat().filter((v): v is string => typeof v === 'string');
      const pe = x.paid_event as { receipt_id?: string; log_index?: number } | null;
      if (pe?.receipt_id) journalRefs.push(`evt:${pe.receipt_id}:${pe.log_index ?? 0}`);
      provider = { name: 'NEAR Intents 1Click', status: String(x.status), detail: { invoice: x.invoice_id, invoiceStatus: x.invoice_status, refundTo: x.refund_to }, updatedAt: iso(x.updated_at as Date) };
      settlementPolicy = 'Complete only when the obiba-pay contract records the invoice as paid on NEAR.';
      evidence = pe?.receipt_id ? { source: 'obiba-pay contract event', verified: true, detail: `Receipt ${pe.receipt_id}` } : null;
    } else if (type === 'onchain') {
      const [receipt, log] = id.split(':');
      const e = (await this.pool.query(`select receipt_id, log_index, block_height::text, token, from_account, to_account, amount::text, tx_hash, raw->>'memo' as memo, observed_at from chain.events where receipt_id = $1 and log_index = $2`, [receipt, Number(log)])).rows[0] as Record<string, unknown>;
      raw = e;
      if (e.tx_hash) txHashes = [String(e.tx_hash)];
      journalRefs.push(`evt:${receipt}:${log}`);
      provider = { name: 'None (direct NEAR transfer)', status: null, detail: null, updatedAt: null };
      settlementPolicy = 'A token transfer observed in a final NEAR block that no Obiba operation initiated. It is attributed to the customer account by receipt and log index.';
      evidence = { source: 'NEAR receipt', verified: true, detail: `Receipt ${receipt} log ${log}, block ${e.block_height}` };
    } else {
      const s = (await this.pool.query(`select kind, provider, right(target, 4) as target_last4, amount::text, status, funding, receipt, quote, op_id, invoice_id, created_at, updated_at from ops.sandbox_ops where id = $1`, [id])).rows[0] as Record<string, unknown>;
      raw = s;
      opId = (s.op_id as string | null) ?? null;
      holdRefs.push(`sandbox:${id}`);
      const receipt = s.receipt as { ref?: string; provider_ref?: string } | null;
      if (receipt?.ref) journalRefs.push(`sandbox:${receipt.ref}`);
      provider = { name: `Pilot rail: ${s.provider}`, status: String(s.status), detail: { kind: s.kind, providerRef: receipt?.provider_ref ?? null, funding: s.funding, targetLast4: s.target_last4 }, updatedAt: iso(s.updated_at as Date) };
      settlementPolicy = s.funding === 'REAL_INTERNAL'
        ? 'Internal real-money test. The USDC payment settles on NEAR to a team-owned pilot biller; no external provider is called.'
        : 'Pilot rail operation on the separate local-services ledger. It never moves USDC.';
    }

    const opRow = opId && opId !== id ? (await this.pool.query('select op_id, status, relay_tx_hashes from ops.prepared_ops where op_id = $1', [opId])).rows[0] as { relay_tx_hashes: string[] } | undefined : undefined;
    if (opRow) txHashes.push(...opRow.relay_tx_hashes);
    txHashes = [...new Set(txHashes)].filter((h) => /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(h));

    const events = txHashes.length
      ? (await this.pool.query<{ receipt_id: string; log_index: number; block_height: string; token: string; from_account: string; to_account: string; amount: string; tx_hash: string; observed_at: Date }>(
          'select receipt_id, log_index, block_height::text, token, from_account, to_account, amount::text, tx_hash, observed_at from chain.events where tx_hash = any($1) order by block_height, log_index',
          [txHashes],
        )).rows
      : [];
    const ingested = txHashes.length ? (await this.pool.query<{ tx_hash: string }>('select tx_hash from chain.ingested_txs where tx_hash = any($1)', [txHashes])).rows.map((x) => x.tx_hash) : [];
    journalRefs = [...new Set([...journalRefs, ...events.map((e) => `evt:${e.receipt_id}:${e.log_index}`)])];
    const journals = journalRefs.length ? await this.journalsByRef(journalRefs) : [];
    const holds = holdRefs.length
      ? (await this.pool.query<{ op_ref: string; amount: string; status: string; currency: string; created_at: Date; expires_at: Date; closed_at: Date | null }>(
          'select h.op_ref, h.amount::text, h.status, a.currency, h.created_at, h.expires_at, h.closed_at from ledger.holds h join ledger.accounts a on a.id = h.account_id where h.op_ref = any($1)',
          [holdRefs],
        )).rows
      : [];
    const guardian = opId ? (await this.pool.query<{ outcome: string; rules: Record<string, unknown>; decided_at: Date; usd: string }>('select outcome, rules, decided_at, usd::text from ops.guardian_decisions where op_id = $1 order by decided_at', [opId])).rows : [];
    const targets = [id, opId].filter((x): x is string => !!x);
    const audit = (await this.pool.query<{ id: string; at: Date; actor: string; action: string; outcome: string; details: Record<string, unknown> }>('select id::text, at, actor, action, outcome, details from audit.log where target = any($1) order by at', [targets])).rows;
    const jobs = opId ? (await this.pool.query<{ id: string; topic: string; created_at: Date; dispatched_at: Date | null }>("select id::text, topic, created_at, dispatched_at from infra.outbox where payload->>'op_id' = $1 order by id", [opId])).rows : [];
    const customer = base.uid ? (await this.pool.query<{ uid: string; display_name: string; handle: string | null; status: string; account_status: string | null; account_id: string | null }>('select u.uid, u.display_name, u.handle, u.status, a.status as account_status, a.account_id from identity.users u left join chain.accounts a on a.uid = u.uid where u.uid = $1', [base.uid])).rows[0] ?? null : null;

    const chainState = events.length ? 'OBSERVED' : txHashes.length ? (ingested.length ? 'NO_TRANSFER_FOUND' : 'SUBMITTED_NOT_OBSERVED') : 'NOT_SUBMITTED';
    const ledgerState = journals.length ? 'POSTED' : holds.some((x) => x.status === 'ACTIVE') ? 'RESERVED' : holds.some((x) => x.status === 'RELEASED') ? 'RELEASED' : 'NOT_POSTED';

    const timeline: { at: string; lane: 'request' | 'provider' | 'chain' | 'ledger' | 'control'; title: string; detail: string | null }[] = [];
    timeline.push({ at: iso(base.created_at)!, lane: 'request', title: type === 'onchain' ? 'Transfer recorded' : 'Created', detail: type === 'onchain' ? 'Not initiated through Obiba' : null });
    for (const h of holds) {
      timeline.push({ at: iso(h.created_at)!, lane: 'ledger', title: 'Funds reserved', detail: `Hold ${h.op_ref}, expires ${iso(h.expires_at)}` });
      if (h.closed_at) timeline.push({ at: iso(h.closed_at)!, lane: 'ledger', title: h.status === 'CAPTURED' ? 'Hold captured' : 'Hold released', detail: h.op_ref });
    }
    for (const g of guardian) timeline.push({ at: iso(g.decided_at)!, lane: 'control', title: g.outcome === 'SIGNED' ? 'Guardian co-signed' : 'Guardian refused', detail: Object.entries(g.rules).filter(([, v]) => v === false).map(([k]) => k).join(', ') || null });
    for (const j of jobs) {
      timeline.push({ at: iso(j.created_at)!, lane: 'request', title: `Job queued: ${j.topic}`, detail: `Outbox ${j.id}` });
      if (j.dispatched_at) timeline.push({ at: iso(j.dispatched_at)!, lane: 'request', title: `Job dispatched: ${j.topic}`, detail: null });
    }
    for (const e of events) timeline.push({ at: iso(e.observed_at)!, lane: 'chain', title: 'Transfer observed on NEAR', detail: `Block ${e.block_height}, ${e.from_account} to ${e.to_account}` });
    for (const j of journals) timeline.push({ at: j.createdAt, lane: 'ledger', title: 'Journal posted', detail: `${j.kind} #${j.id}` });
    for (const a of audit) timeline.push({ at: iso(a.at)!, lane: 'control', title: a.action, detail: `${a.actor.replace(/^staff:/, '')} · ${a.outcome}` });
    if (+new Date(base.updated_at) > +new Date(base.created_at)) timeline.push({ at: iso(base.updated_at)!, lane: 'provider', title: `Status is ${base.status}`, detail: 'Last status change recorded' });
    timeline.sort((a, b) => a.at.localeCompare(b.at));

    const reviewType = type === 'invoice_deposit' ? 'invoice_payment' : type === 'local' ? 'sandbox' : type;
    const inReview = base.phase === 'review' && ['deposit', 'withdrawal', 'invoice_payment', 'sandbox'].includes(reviewType);
    const attention: string[] = [];
    if (base.phase === 'unknown') attention.push('The outcome is unknown. It was submitted but neither settlement nor failure has been proven. It must not be resent; investigate the relay transaction on the explorer.');
    if (base.phase === 'review') attention.push('Automatic processing stopped and a person must decide the outcome with evidence.');
    if (holds.some((h) => h.status === 'ACTIVE' && +h.expires_at < Date.now())) attention.push('A hold is past its expiry and has not been closed.');
    if (chainState === 'SUBMITTED_NOT_OBSERVED' && base.phase === 'pending') attention.push('A transaction was submitted but its transfer has not been observed by the indexer yet.');

    return {
      observedAt: new Date().toISOString(),
      type,
      id,
      status: base.status,
      phase: base.phase,
      amount: base.amount,
      currency: base.currency,
      counterparty: base.counterparty,
      reference: base.reference,
      rail: base.rail,
      createdAt: iso(base.created_at),
      updatedAt: iso(base.updated_at),
      opId,
      customer: customer ? { uid: customer.uid, name: customer.display_name, handle: customer.handle, status: customer.status, accountId: customer.account_id, accountStatus: customer.account_status } : null,
      states: {
        provider,
        chain: { state: chainState, txHashes, ingested, network: this.settings.network },
        ledger: { state: ledgerState, journals: journals.length, holds: holds.map((h) => h.status) },
      },
      settlementPolicy,
      evidence,
      details: Object.fromEntries(Object.entries(raw).filter(([k]) => !['created_at', 'updated_at', 'canonical', 'signed_delegate'].includes(k)).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])),
      chainEvents: events.map((e) => ({ receiptId: e.receipt_id, logIndex: e.log_index, blockHeight: e.block_height, token: e.token, from: e.from_account, to: e.to_account, amount: e.amount, txHash: e.tx_hash, observedAt: iso(e.observed_at) })),
      journals,
      holds: holds.map((h) => ({ ref: h.op_ref, amount: h.amount, currency: h.currency, status: h.status, createdAt: iso(h.created_at), expiresAt: iso(h.expires_at), closedAt: iso(h.closed_at) })),
      guardian: guardian.map((g) => ({ outcome: g.outcome, rules: g.rules, usd: g.usd, decidedAt: iso(g.decided_at) })),
      jobs: jobs.map((j) => ({ id: j.id, topic: j.topic, createdAt: iso(j.created_at), dispatchedAt: iso(j.dispatched_at) })),
      audit: audit.map((a) => ({ id: a.id, at: iso(a.at), actor: a.actor, action: a.action, outcome: a.outcome })),
      timeline,
      attention,
      review: inReview ? { type: reviewType, allowed: reviewTargets(reviewType) } : null,
    };
  }

  private async journalsByRef(refs: string[]) {
    const r = await this.pool.query<{ id: string; op_ref: string; kind: string; domain: string; created_at: Date; entries: { account: string; kind: string; amount: string; currency: string }[] }>(
      `select j.id::text, j.op_ref, j.kind, j.domain::text, j.created_at,
              coalesce(json_agg(json_build_object('account', a.ref, 'kind', a.kind, 'amount', e.amount::text, 'currency', e.currency) order by e.id) filter (where e.id is not null), '[]') as entries
         from ledger.journals j left join ledger.entries e on e.journal_id = j.id left join ledger.accounts a on a.id = e.account_id
        where j.op_ref = any($1) group by j.id order by j.id`,
      [refs],
    );
    return r.rows.map((j) => ({ id: j.id, opRef: j.op_ref, kind: j.kind, domain: j.domain, createdAt: iso(j.created_at)!, entries: j.entries }));
  }

  async customers(query: Record<string, unknown>, role: StaffRole) {
    const q = search(query.q);
    const status = oneOf(query.status, ['active', 'disabled', 'frozen', 'quarantined', 'provisioning'] as const);
    const cursor = decodeCursor(query.cursor);
    const limit = limitOf(query.limit);
    const contact = ROLES.indexOf(role) >= ROLES.indexOf('operator');
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (q) {
      const exact = p(q);
      const handle = p(q.replace(/^@/, '').toLowerCase());
      const like = p(`${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      const parts = [`u.uid = ${exact}`, `a.account_id = ${exact}`, `u.handle = ${handle}`, `u.account_name = ${handle}`, `u.display_name ilike ${like}`, `a.account_id ilike ${like}`];
      if (contact) parts.push(`lower(u.email) = lower(${exact})`, `u.phone_e164 = ${exact}`);
      where.push(`(${parts.join(' or ')})`);
    }
    if (status === 'active' || status === 'disabled') where.push(`u.status = ${p(status)}`);
    else if (status) where.push(`a.status = ${p(status)}`);
    if (cursor) where.push(`(u.created_at, u.uid) < (${p(cursor[0])}::timestamptz, ${p(cursor[1])})`);
    const r = await this.pool.query<{ uid: string; display_name: string; handle: string | null; email: string; phone_e164: string; status: string; pilot_allowed: boolean; merchant: boolean; internal_tester: boolean; phone_verified_at: Date | null; created_at: Date; account_id: string | null; account_status: string | null; posted: string | null; held: string | null; last_activity: Date | null; open_cases: string }>(
      `select u.uid, u.display_name, u.handle, u.email, u.phone_e164, u.status, u.pilot_allowed, u.merchant, u.internal_tester, u.phone_verified_at, u.created_at,
              a.account_id, a.status as account_status, b.posted::text, b.held::text,
              greatest((select max(updated_at) from ops.prepared_ops x where x.uid = u.uid), (select max(updated_at) from ops.deposits x where x.uid = u.uid), (select max(updated_at) from ops.sandbox_ops x where x.uid = u.uid)) as last_activity,
              (select count(*) from ops.support_cases s where s.uid = u.uid and s.status in ('OPEN', 'VERIFIED', 'APPROVED'))::text as open_cases
         from identity.users u left join chain.accounts a on a.uid = u.uid
         left join ledger.accounts la on la.domain = 'REAL' and la.ref = 'wallet:' || a.account_id and la.currency = 'USDC'
         left join ledger.balances b on b.account_id = la.id
         ${where.length ? `where ${where.join(' and ')}` : ''}
        order by u.created_at desc, u.uid desc limit ${p(limit + 1)}`,
      params,
    );
    const rows = r.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      observedAt: new Date().toISOString(),
      rows: rows.map((u) => ({
        uid: u.uid,
        name: u.display_name,
        handle: u.handle,
        email: maskEmail(u.email),
        phone: maskPhone(u.phone_e164),
        status: u.status,
        accountId: u.account_id,
        accountStatus: u.account_status,
        phoneVerified: !!u.phone_verified_at,
        pilot: u.pilot_allowed,
        merchant: u.merchant,
        internalTester: u.internal_tester,
        balance: u.posted,
        held: u.held,
        currency: 'USDC',
        openCases: Number(u.open_cases),
        lastActivity: iso(u.last_activity),
        createdAt: iso(u.created_at),
      })),
      nextCursor: r.rows.length > limit && last ? encodeCursor(last.created_at, last.uid) : null,
    };
  }

  async customer(uid: string) {
    if (!UID.test(uid)) throw new AdminError(400, 'invalid customer');
    const u = (await this.pool.query<{ uid: string; display_name: string; handle: string | null; account_name: string | null; email: string; phone_e164: string; status: string; pilot_allowed: boolean; merchant: boolean; internal_tester: boolean; phone_verified_at: Date | null; created_at: Date; updated_at: Date; account_id: string | null; account_status: string | null; account_created: Date | null }>(
      `select u.uid, u.display_name, u.handle, u.account_name, u.email, u.phone_e164, u.status, u.pilot_allowed, u.merchant, u.internal_tester, u.phone_verified_at, u.created_at, u.updated_at,
              a.account_id, a.status as account_status, a.created_at as account_created
         from identity.users u left join chain.accounts a on a.uid = u.uid where u.uid = $1`,
      [uid],
    )).rows[0];
    if (!u) throw new AdminError(404, 'customer not found');
    const refs = u.account_id ? [`wallet:${u.account_id}`] : [];
    const [balances, demo, devices, cases, recoveries, kit, recon] = await Promise.all([
      refs.length
        ? this.pool.query<{ currency: string; posted: string; held: string }>("select a.currency, b.posted::text, b.held::text from ledger.accounts a join ledger.balances b on b.account_id = a.id where a.domain = 'REAL' and a.ref = any($1)", [refs]).then((r) => r.rows)
        : Promise.resolve([]),
      this.pool.query<{ currency: string; posted: string; held: string }>("select a.currency, b.posted::text, b.held::text from ledger.accounts a join ledger.balances b on b.account_id = a.id where a.domain = 'DEMO' and a.kind = 'DEMO_USER' and a.ref like $1", [`%${uid}`]).then((r) => r.rows),
      this.pool.query<{ public_key: string; status: string; initial: boolean; created_at: Date }>('select public_key, status, initial, created_at from identity.devices where uid = $1 order by created_at', [uid]).then((r) => r.rows),
      this.pool.query<{ id: string; status: string; source: string; created_at: Date; updated_at: Date; verified_by: string | null; approved_by: string | null }>('select id::text, status, source, created_at, updated_at, verified_by, approved_by from ops.support_cases where uid = $1 order by created_at desc', [uid]).then((r) => r.rows),
      this.pool.query<{ id: string; method: string; status: string; created_at: Date; reason: string | null }>('select id::text, method, status, created_at, reason from ops.recoveries where uid = $1 order by created_at desc limit 20', [uid]).then((r) => r.rows),
      this.pool.query<{ n: string }>('select count(*)::text as n from identity.recovery_kits where uid = $1', [uid]).then((r) => Number(r.rows[0]?.n ?? 0)).catch(() => null),
      u.account_id ? this.pool.query<{ matched: boolean; checked_at: Date }>('select matched, checked_at from ops.reconciliation_runs where account_id = $1 order by checked_at desc limit 1', [u.account_id]).then((r) => r.rows[0] ?? null) : Promise.resolve(null),
    ]);
    const restrictions: { kind: string; effect: string }[] = [];
    if (u.status === 'disabled') restrictions.push({ kind: 'Profile disabled', effect: 'Cannot sign in to Obiba. Funds remain in the customer-owned NEAR account.' });
    if (u.account_status === 'frozen') restrictions.push({ kind: 'Account frozen', effect: 'Obiba will not relay or co-sign new operations. Already submitted transactions are not cancelled.' });
    if (u.account_status === 'quarantined') restrictions.push({ kind: 'Account quarantined', effect: 'Held for review after provisioning. No new operations are relayed.' });
    if (!u.pilot_allowed) restrictions.push({ kind: 'Awaiting pilot access', effect: 'Cannot use the product until approved for the pilot.' });
    return {
      observedAt: new Date().toISOString(),
      uid: u.uid,
      name: u.display_name,
      handle: u.handle,
      accountName: u.account_name,
      email: maskEmail(u.email),
      phone: maskPhone(u.phone_e164),
      masked: true,
      status: u.status,
      flags: { pilot: u.pilot_allowed, merchant: u.merchant, internalTester: u.internal_tester },
      verification: {
        email: 'Verified at sign-up by the identity provider',
        phone: u.phone_verified_at ? `SMS verified ${iso(u.phone_verified_at)}` : 'Not verified by SMS',
        identity: 'Financial identity verification is not performed by Obiba in this release',
        recoveryKit: kit === null ? 'Unknown' : kit > 0 ? 'Registered' : 'Not registered',
      },
      account: u.account_id ? { id: u.account_id, status: u.account_status, createdAt: iso(u.account_created), custody: 'Customer-owned NEAR Smart Account. Obiba keys cannot move funds alone.', lastReconciliation: recon ? { matched: recon.matched, checkedAt: iso(recon.checked_at) } : null } : null,
      balances: balances.map((b) => ({ currency: b.currency, posted: b.posted, held: b.held, available: (BigInt(b.posted) - BigInt(b.held)).toString(), domain: 'REAL' })),
      localBalances: demo.map((b) => ({ currency: b.currency, posted: b.posted, held: b.held, available: (BigInt(b.posted) - BigInt(b.held)).toString(), domain: 'DEMO' })),
      devices: devices.map((d) => ({ publicKey: d.public_key, status: d.status, initial: d.initial, createdAt: iso(d.created_at) })),
      cases: cases.map((c) => ({ id: c.id, kind: 'Account restore', status: c.status, source: c.source, createdAt: iso(c.created_at), updatedAt: iso(c.updated_at), verifiedBy: c.verified_by, approvedBy: c.approved_by })),
      recoveries: recoveries.map((r) => ({ id: r.id, method: r.method, status: r.status, createdAt: iso(r.created_at), reason: r.reason })),
      restrictions,
      createdAt: iso(u.created_at),
      updatedAt: iso(u.updated_at),
    };
  }

  async reveal(actor: string, uid: string, rawReason: unknown) {
    if (!UID.test(uid)) throw new AdminError(400, 'invalid customer');
    const why = reason(rawReason);
    const u = (await this.pool.query<{ email: string; phone_e164: string }>('select email, phone_e164 from identity.users where uid = $1', [uid])).rows[0];
    if (!u) throw new AdminError(404, 'customer not found');
    await this.record(actor, 'customer.reveal', uid, { fields: ['email', 'phone'], reason: why });
    return { email: u.email, phone: u.phone_e164, revealedAt: new Date().toISOString(), expiresInSeconds: 120 };
  }

  async ledger() {
    const [now, totals, journalCheck, cacheCheck, holdCheck, recon, holds] = await Promise.all([
      this.pool.query<{ now: Date }>('select now()').then((r) => iso(r.rows[0]!.now)!),
      this.pool.query<{ domain: string; currency: string; kind: string; accounts: string; posted: string; held: string }>(
        `select a.domain::text, a.currency, a.kind, count(*)::text as accounts, coalesce(sum(b.posted), 0)::text as posted, coalesce(sum(b.held), 0)::text as held
           from ledger.accounts a join ledger.balances b on b.account_id = a.id group by 1, 2, 3 order by 1 desc, 2, 3`,
      ),
      this.pool.query<{ currency: string; journals: string; unbalanced: string; amount: string }>(
        `select currency, count(*)::text as journals, count(*) filter (where total <> 0)::text as unbalanced, coalesce(sum(abs(total)), 0)::text as amount
           from (select journal_id, currency, sum(amount) as total from ledger.entries group by 1, 2) j group by currency`,
      ),
      this.pool.query<{ account_ref: string; currency: string; cached: string; computed: string }>(
        `select a.ref as account_ref, a.currency, b.posted::text as cached, coalesce(s.total, 0)::text as computed
           from ledger.balances b join ledger.accounts a on a.id = b.account_id
           left join (select account_id, sum(amount) as total from ledger.entries group by 1) s on s.account_id = b.account_id
          where b.posted <> coalesce(s.total, 0) limit 100`,
      ),
      this.pool.query<{ account_ref: string; currency: string; cached: string; computed: string }>(
        `select a.ref as account_ref, a.currency, b.held::text as cached, coalesce(h.total, 0)::text as computed
           from ledger.balances b join ledger.accounts a on a.id = b.account_id
           left join (select account_id, sum(amount) as total from ledger.holds where status = 'ACTIVE' group by 1) h on h.account_id = b.account_id
          where b.held <> coalesce(h.total, 0) limit 100`,
      ),
      this.reconLatest(),
      this.pool.query<{ op_ref: string; account_ref: string; currency: string; amount: string; status: string; created_at: Date; expires_at: Date }>(
        `select h.op_ref, a.ref as account_ref, a.currency, h.amount::text, h.status, h.created_at, h.expires_at
           from ledger.holds h join ledger.accounts a on a.id = h.account_id where h.status = 'ACTIVE' order by h.created_at limit 100`,
      ),
    ]);
    const accounts = (await this.pool.query<{ n: string }>('select count(*)::text as n from ledger.balances')).rows[0]!.n;
    const unbalanced = journalCheck.rows.reduce((s, r) => s + Number(r.unbalanced), 0);
    const totalJournals = journalCheck.rows.reduce((s, r) => s + Number(r.journals), 0);
    const checks = [
      {
        key: 'journals',
        title: 'Debits equal credits',
        scope: 'Every journal, per currency',
        result: unbalanced === 0 ? 'MATCHED' : 'MISMATCHED',
        checked: totalJournals,
        exceptions: unbalanced,
        detail: unbalanced === 0 ? `${totalJournals} journal-currency pairs net to zero` : `${unbalanced} journals do not net to zero`,
        byCurrency: journalCheck.rows.map((r) => ({ currency: r.currency, exceptions: Number(r.unbalanced), amount: r.amount })),
      },
      {
        key: 'balances',
        title: 'Cached balances equal entries',
        scope: 'Every ledger account',
        result: cacheCheck.rows.length === 0 ? 'MATCHED' : 'MISMATCHED',
        checked: Number(accounts),
        exceptions: cacheCheck.rows.length,
        detail: cacheCheck.rows.length === 0 ? `${accounts} account balances equal the sum of their entries` : `${cacheCheck.rows.length} accounts differ from their entries`,
        rows: cacheCheck.rows.map((r) => ({ account: r.account_ref, currency: r.currency, expected: r.computed, actual: r.cached, difference: (BigInt(r.cached) - BigInt(r.computed)).toString() })),
      },
      {
        key: 'holds',
        title: 'Reserved balances equal active holds',
        scope: 'Every ledger account',
        result: holdCheck.rows.length === 0 ? 'MATCHED' : 'MISMATCHED',
        checked: Number(accounts),
        exceptions: holdCheck.rows.length,
        detail: holdCheck.rows.length === 0 ? 'Every reserved balance equals its active holds' : `${holdCheck.rows.length} accounts have reserved amounts that differ from active holds`,
        rows: holdCheck.rows.map((r) => ({ account: r.account_ref, currency: r.currency, expected: r.computed, actual: r.cached, difference: (BigInt(r.cached) - BigInt(r.computed)).toString() })),
      },
      {
        key: 'chain',
        title: 'Ledger equals on-chain balance',
        scope: 'Customer accounts, at the last reconciled block',
        result: recon.accounts === 0 ? 'UNKNOWN' : recon.lastCheckedAt && Date.parse(now) - Date.parse(recon.lastCheckedAt) > STALE_AFTER_MS ? 'STALE' : recon.mismatched === 0 ? 'MATCHED' : 'MISMATCHED',
        checked: recon.accounts,
        exceptions: recon.mismatched,
        detail: recon.accounts === 0 ? 'No reconciliation runs recorded' : `Last run ${recon.lastCheckedAt}`,
        observedAt: recon.lastCheckedAt,
      },
    ];
    return {
      observedAt: now,
      computedOnRequest: true,
      totals: totals.rows.map((t) => ({ domain: t.domain, currency: t.currency, kind: t.kind, accounts: Number(t.accounts), posted: t.posted, held: t.held })),
      checks,
      reconciliation: recon,
      holds: holds.rows.map((h) => ({ ref: h.op_ref, account: h.account_ref, currency: h.currency, amount: h.amount, status: h.status, createdAt: iso(h.created_at), expiresAt: iso(h.expires_at), expired: +h.expires_at < Date.parse(now) })),
      assets: ASSETS,
    };
  }

  async journals(query: Record<string, unknown>) {
    const domain = oneOf(query.domain, ['REAL', 'DEMO'] as const);
    const q = search(query.q);
    const cursor = decodeCursor(query.cursor);
    const limit = limitOf(query.limit);
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (domain) where.push(`j.domain = ${p(domain)}::ledger.domain`);
    if (q) {
      const like = p(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      where.push(`(j.op_ref ilike ${like} or j.id::text = ${p(q)} or exists (select 1 from ledger.entries e2 join ledger.accounts a2 on a2.id = e2.account_id where e2.journal_id = j.id and a2.ref ilike ${like}))`);
    }
    if (cursor) where.push(`(j.created_at, j.id::text) < (${p(cursor[0])}::timestamptz, ${p(cursor[1])})`);
    const r = await this.pool.query<{ id: string; op_ref: string; kind: string; domain: string; created_at: Date; source: Record<string, unknown> | null; entries: { account: string; kind: string; amount: string; currency: string }[] }>(
      `select j.id::text, j.op_ref, j.kind, j.domain::text, j.created_at, j.source,
              coalesce(json_agg(json_build_object('account', a.ref, 'kind', a.kind, 'amount', e.amount::text, 'currency', e.currency) order by e.id) filter (where e.id is not null), '[]') as entries
         from ledger.journals j left join ledger.entries e on e.journal_id = j.id left join ledger.accounts a on a.id = e.account_id
         ${where.length ? `where ${where.join(' and ')}` : ''}
        group by j.id order by j.created_at desc, j.id::text desc limit ${p(limit + 1)}`,
      params,
    );
    const rows = r.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      observedAt: new Date().toISOString(),
      rows: rows.map((j) => ({ id: j.id, opRef: j.op_ref, kind: j.kind, domain: j.domain, createdAt: iso(j.created_at), source: j.source, entries: j.entries })),
      nextCursor: r.rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  async treasury() {
    const [now, rows, holds, inTransit] = await Promise.all([
      this.pool.query<{ now: Date }>('select now()').then((r) => iso(r.rows[0]!.now)!),
      this.pool.query<{ domain: string; currency: string; kind: string; ref: string; posted: string; held: string }>(
        `select a.domain::text, a.currency, a.kind, a.ref, b.posted::text, b.held::text from ledger.accounts a join ledger.balances b on b.account_id = a.id
          where a.kind in ('TREASURY', 'CLEARING', 'WALLET') and a.domain = 'REAL' order by a.kind, a.ref`,
      ),
      this.pool.query<{ currency: string; amount: string; n: string }>(
        "select a.currency, coalesce(sum(h.amount), 0)::text as amount, count(*)::text as n from ledger.holds h join ledger.accounts a on a.id = h.account_id where h.status = 'ACTIVE' and a.domain = 'REAL' group by 1",
      ),
      this.pool.query<{ kind: string; currency: string; amount: string; n: string }>(
        `select 'withdrawal' as kind, 'USDC' as currency, coalesce(sum(amount_in), 0)::text as amount, count(*)::text as n from ops.withdrawals where status in ('SUBMITTED', 'SENT', 'PROCESSING', 'VERIFYING')
         union all
         select 'deposit', 'USDC', coalesce(sum(min_amount_out), 0)::text, count(*)::text from ops.deposits where status in ('DETECTED', 'CONVERTING', 'VERIFYING_SETTLEMENT')`,
      ),
    ]);
    const recon = await this.reconLatest();
    const stale = recon.lastCheckedAt === null || Date.parse(now) - Date.parse(recon.lastCheckedAt) > STALE_AFTER_MS;
    const sum = (kind: string, currency: string, field: 'posted' | 'held') => rows.rows.filter((r) => r.kind === kind && r.currency === currency).reduce((s, r) => s + BigInt(r[field]), 0n).toString();
    const currencies = [...new Set(rows.rows.map((r) => r.currency))];
    if (!currencies.includes('USDC')) currencies.unshift('USDC');
    const watched = this.settings.watchAccounts.length ? await this.watchedBalances() : [];
    return {
      observedAt: now,
      model: 'Self-custodial. Customer funds sit in customer-owned NEAR Smart Accounts and are not Obiba-controlled backing. Obiba controls only its treasury and the payment clearing contract.',
      assets: currencies.map((currency) => ({
        currency,
        network: this.settings.network ? `NEAR ${this.settings.network}` : 'NEAR',
        obibaControlled: {
          treasury: sum('TREASURY', currency, 'posted'),
          clearing: sum('CLEARING', currency, 'posted'),
          accounts: rows.rows.filter((r) => (r.kind === 'TREASURY' || r.kind === 'CLEARING') && r.currency === currency).map((r) => ({ ref: r.ref, kind: r.kind, posted: r.posted })),
        },
        customerControlled: { posted: sum('WALLET', currency, 'posted'), held: sum('WALLET', currency, 'held'), accounts: rows.rows.filter((r) => r.kind === 'WALLET' && r.currency === currency).length },
        reserved: holds.rows.find((h) => h.currency === currency) ?? { currency, amount: '0', n: '0' },
        inTransit: inTransit.rows.filter((t) => t.currency === currency).map((t) => ({ kind: t.kind, amount: t.amount, count: Number(t.n) })),
        verification: stale ? 'UNVERIFIED' : recon.mismatched > 0 ? 'MISMATCHED' : 'VERIFIED',
        verifiedAt: recon.lastCheckedAt,
      })),
      operatingAccounts: watched.map((w) => ({ account: w.account, label: w.label, asset: 'NEAR', amount: w.amount, threshold: w.minNear, decimals: 24, state: w.amount === null ? 'UNKNOWN' : BigInt(w.amount) < BigInt(w.minNear) ? 'CRITICAL' : 'HEALTHY', observedAt: w.observedAt })),
      operatingAccountsConfigured: this.settings.watchAccounts.length > 0,
      requestsSupported: false,
      assetsMeta: ASSETS,
    };
  }

  async providers() {
    const [head, guardian, fx, intents, rail, tokens, ingest] = await Promise.all([
      this.chainHead(),
      this.guardianProbe(),
      this.redis.get('fx:usd:v3').then((raw) => (raw ? (JSON.parse(raw) as { fetchedAt: number; values: Record<string, { rate: string; asOf: string }> }) : null)).catch(() => undefined),
      this.pool.query<{ kind: string; status: string; n: string; last: Date }>(
        `select 'deposit' as kind, status, count(*)::text as n, max(updated_at) as last from ops.deposits where created_at > now() - interval '7 days' group by 1, 2
         union all select 'withdrawal', status, count(*)::text, max(updated_at) from ops.withdrawals where created_at > now() - interval '7 days' group by 1, 2
         union all select 'invoice', status, count(*)::text, max(updated_at) from ops.invoice_deposits where created_at > now() - interval '7 days' group by 1, 2`,
      ),
      this.pool.query<{ provider: string; status: string; n: string; last: Date }>("select provider, status, count(*)::text as n, max(updated_at) as last from ops.sandbox_ops where created_at > now() - interval '7 days' group by 1, 2"),
      this.pool.query<{ token: string; events: string; last: Date | null }>("select token, count(*)::text as events, max(observed_at) as last from chain.events group by 1 order by 2 desc"),
      this.pool.query<{ height: string | null; last: Date | null }>("select (select block_height::text from chain.cursor where stream = 'blocks') as height, (select max(observed_at) from chain.events) as last"),
    ]);
    const cursor = ingest.rows[0]?.height ? Number(ingest.rows[0].height) : null;
    const group = <T extends { status: string; n: string; last: Date }>(rows: T[]) => {
      const total = rows.reduce((s, r) => s + Number(r.n), 0);
      const failed = rows.filter((r) => ['FAILED', 'EXPIRED', 'INCOMPLETE'].includes(r.status)).reduce((s, r) => s + Number(r.n), 0);
      const review = rows.filter((r) => ['REVIEW_REQUIRED', 'REVIEW'].includes(r.status)).reduce((s, r) => s + Number(r.n), 0);
      const last = rows.map((r) => r.last).sort((a, b) => +b - +a)[0];
      return { total, failed, review, byStatus: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])), lastActivity: iso(last ?? null) };
    };
    const fxAge = fx ? Date.now() - fx.fetchedAt : null;
    return {
      observedAt: new Date().toISOString(),
      providers: [
        {
          key: 'near',
          name: this.settings.network ? `NEAR Protocol ${this.settings.network}` : 'NEAR Protocol',
          role: 'Settlement network for USDC and Smart Accounts',
          owner: 'Engineering',
          state: !this.settings.rpcUrl ? 'NOT_CONFIGURED' : head ? 'HEALTHY' : 'CRITICAL',
          metrics: [
            { label: 'Final head', value: head ? head.height.toLocaleString('en-US') : '—' },
            { label: 'RPC latency', value: head ? `${head.latencyMs} ms` : '—' },
            { label: 'Indexer cursor', value: cursor !== null ? cursor.toLocaleString('en-US') : '—' },
            { label: 'Indexer lag', value: head && cursor !== null ? `${(head.height - cursor).toLocaleString('en-US')} blocks` : '—' },
          ],
          settlementPolicy: 'Final-block finality; transfers are attributed by receipt and log index and consumed once.',
          observedAt: head?.observedAt ?? null,
        },
        {
          key: 'intents',
          name: 'NEAR Intents 1Click',
          role: 'Cross-chain deposits, withdrawals and invoice payments',
          owner: 'Operations',
          state: 'UNKNOWN',
          stateNote: 'Provider uptime is not probed from this console; outcomes are shown from operation records.',
          metrics: (['deposit', 'withdrawal', 'invoice'] as const).map((k) => {
            const g = group(intents.rows.filter((r) => r.kind === k));
            return { label: `${k[0]!.toUpperCase()}${k.slice(1)}s, 7 days`, value: `${g.total} total · ${g.failed} failed · ${g.review} review` };
          }),
          settlementPolicy: 'Provider completion never credits. Settlement requires an attributed NEAR or destination-chain transfer.',
          observedAt: iso(intents.rows.map((r) => r.last).sort((a, b) => +b - +a)[0] ?? null),
        },
        {
          key: 'guardian',
          name: 'Guardian co-signer',
          role: 'Independent co-signature above the daily limit and for recoveries',
          owner: 'Security',
          state: guardian === null ? 'NOT_CONFIGURED' : guardian.ok ? 'HEALTHY' : 'CRITICAL',
          metrics: [
            { label: 'Health check', value: guardian === null ? 'Not configured' : guardian.ok ? `OK in ${guardian.latencyMs} ms` : `Failed${guardian.status ? ` (${guardian.status})` : ''}` },
          ],
          settlementPolicy: 'Runs on its own VM with its own KMS key. The console only reads its health.',
          observedAt: guardian?.observedAt ?? null,
        },
        {
          key: 'fx',
          name: 'Frankfurter',
          role: 'Indicative USD to GHS, KES, NGN and ZAR rates',
          owner: 'Finance',
          state: fx === undefined ? 'UNKNOWN' : fx === null ? 'NOT_CONFIGURED' : fxAge! > 4 * 86_400_000 ? 'STALE' : fxAge! > 36 * 3_600_000 ? 'WARNING' : 'HEALTHY',
          metrics: fx
            ? Object.entries(fx.values).slice(0, 4).map(([cur, v]) => ({ label: `USD/${cur}`, value: `${v.rate} on ${String(v.asOf).slice(0, 10)}` }))
            : [{ label: 'Rate cache', value: fx === null ? 'Empty' : 'Unreachable' }],
          settlementPolicy: 'Indicative only. Never used for authoritative ledger amounts; quotes are refused once the rate is older than 4 days.',
          observedAt: fx ? new Date(fx.fetchedAt).toISOString() : null,
        },
        {
          key: 'rail',
          name: 'Local services pilot rail',
          role: 'Mobile money, airtime, data and utility payments in pilot',
          owner: 'Operations',
          state: 'HEALTHY',
          stateNote: 'In pilot. Not connected to external providers.',
          metrics: [...new Set(rail.rows.map((r) => r.provider))].map((p) => {
            const g = group(rail.rows.filter((r) => r.provider === p));
            return { label: p, value: `${g.total} total · ${g.failed} failed · ${g.review} review` };
          }),
          settlementPolicy: 'Runs on the separate local-services ledger and never moves USDC.',
          observedAt: iso(rail.rows.map((r) => r.last).sort((a, b) => +b - +a)[0] ?? null),
        },
        {
          key: 'identity',
          name: 'Google Identity Platform',
          role: 'Customer sign-in, email verification and SMS factors',
          owner: 'Security',
          state: this.settings.identityProject ? 'UNKNOWN' : 'NOT_CONFIGURED',
          stateNote: this.settings.identityProject ? 'Used for support recoveries; availability is not probed from this console.' : 'Not configured for this console, so support recoveries cannot restore sign-in.',
          metrics: [{ label: 'Project', value: this.settings.identityProject ?? 'Not configured' }],
          settlementPolicy: 'Staff access does not use customer identities.',
          observedAt: null,
        },
      ],
      assets: tokens.rows.map((t) => ({ token: t.token, currency: 'USDC', decimals: USDC_DECIMALS, network: this.settings.network ? `NEAR ${this.settings.network}` : 'NEAR', events: Number(t.events), lastObserved: iso(t.last) })),
    };
  }

  async jobs() {
    const [queues, outbox, stuck, cursor, head] = await Promise.all([
      this.queues(),
      this.pool.query<{ topic: string; pending: string; oldest: Date | null; dispatched_24h: string; last_dispatched: Date | null; total: string }>(
        `select topic, count(*) filter (where dispatched_at is null)::text as pending, min(created_at) filter (where dispatched_at is null) as oldest,
                count(*) filter (where dispatched_at > now() - interval '24 hours')::text as dispatched_24h, max(dispatched_at) as last_dispatched, count(*)::text as total
           from infra.outbox group by topic order by topic`,
      ),
      this.pool.query<{ op_id: string; status: string; relay_attempts: number; updated_at: Date; uid: string }>(
        `select op_id, status, relay_attempts, updated_at, uid from ops.prepared_ops where status in ('SUBMITTED', 'RELAYED', 'UNKNOWN', 'COSIGNED') and updated_at < now() - interval '10 minutes' order by updated_at limit 50`,
      ),
      this.pool.query<{ stream: string; block_height: string }>('select stream, block_height::text from chain.cursor'),
      this.chainHead(),
    ]);
    return {
      observedAt: new Date().toISOString(),
      queues,
      outbox: outbox.rows.map((o) => ({ topic: o.topic, pending: Number(o.pending), oldest: iso(o.oldest), dispatched24h: Number(o.dispatched_24h), lastDispatched: iso(o.last_dispatched), total: Number(o.total) })),
      stuck: stuck.rows.map((s) => ({ opId: s.op_id, status: s.status, attempts: s.relay_attempts, since: iso(s.updated_at), uid: s.uid })),
      streams: cursor.rows.map((c) => ({ stream: c.stream, height: c.block_height, head: head?.height ?? null, lag: head ? head.height - Number(c.block_height) : null, observedAt: head?.observedAt ?? null })),
      heartbeats: { configured: false, note: 'Workers, the indexer and the scheduler do not publish heartbeats yet. Liveness is inferred from queue activity only.' },
      retryPolicy: 'Retries are not offered here. Submitted or unknown sends cannot be retried; eligible retries run inside each job with its original idempotency key.',
    };
  }

  async auditLog(query: Record<string, unknown>) {
    const q = search(query.q);
    const actor = search(query.actor);
    const action = search(query.action);
    const outcome = oneOf(query.outcome, ['ALLOWED', 'DENIED', 'FAILED'] as const);
    const kind = oneOf(query.kind, ['staff', 'customer', 'service'] as const);
    const from = timeOf(query.from);
    const to = timeOf(query.to);
    const cursor = decodeCursor(query.cursor);
    const limit = limitOf(query.limit, 50, 200);
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (q) where.push(`(l.target = ${p(q)} or l.request_id = ${p(q)} or l.id::text = ${p(q)})`);
    if (actor) where.push(`l.actor ilike ${p(`%${actor.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)}`);
    if (action) where.push(`l.action like ${p(`${action.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)}`);
    if (outcome) where.push(`l.outcome = ${p(outcome)}`);
    if (kind === 'staff') where.push("l.actor like 'staff:%'");
    if (kind === 'service') where.push("l.actor like '%@%' and l.actor not like 'staff:%'");
    if (kind === 'customer') where.push("l.actor not like '%@%' and l.actor not like 'staff:%'");
    if (from) where.push(`l.at >= ${p(from)}`);
    if (to) where.push(`l.at < ${p(to)}`);
    if (cursor) where.push(`(l.at, l.id::text) < (${p(cursor[0])}::timestamptz, ${p(cursor[1])})`);
    const r = await this.pool.query<{ id: string; at: Date; actor: string; action: string; target: string | null; outcome: string; request_id: string | null; details: Record<string, unknown> }>(
      `select l.id::text, l.at, l.actor, l.action, l.target, l.outcome, l.request_id, l.details from audit.log l
        ${where.length ? `where ${where.join(' and ')}` : ''} order by l.at desc, l.id desc limit ${p(limit + 1)}`,
      params,
    );
    const actions = (await this.pool.query<{ action: string }>('select distinct action from audit.log order by 1 limit 200')).rows.map((x) => x.action);
    const rows = r.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      observedAt: new Date().toISOString(),
      rows: rows.map((l) => ({ id: l.id, at: iso(l.at), actor: l.actor, actorKind: l.actor.startsWith('staff:') ? 'staff' : l.actor.includes('@') ? 'service' : 'customer', action: l.action, target: l.target, outcome: l.outcome, requestId: l.request_id, details: l.details })),
      actions,
      nextCursor: r.rows.length > limit && last ? encodeCursor(last.at, last.id) : null,
      integrity: 'Rows are append-only for the console role. Tamper-evident external storage is not configured.',
    };
  }

  async staff() {
    const emails = [...this.settings.staff.keys()];
    const r = await this.pool.query<{ actor: string; last: Date; actions: string; denied: string }>(
      `select actor, max(at) as last, count(*)::text as actions, count(*) filter (where outcome = 'DENIED')::text as denied from audit.log where actor = any($1) group by actor`,
      [emails.map((e) => `staff:${e}`)],
    );
    const by = new Map(r.rows.map((x) => [x.actor.slice(6), x]));
    return {
      observedAt: new Date().toISOString(),
      source: 'STAFF_ROLES deployment configuration behind Identity-Aware Proxy',
      members: emails.map((email) => ({ email, role: this.settings.staff.get(email)!, lastAction: iso(by.get(email)?.last ?? null), actions: Number(by.get(email)?.actions ?? 0), denied: Number(by.get(email)?.denied ?? 0) })),
      roles: ROLES.map((role) => ({ role, capabilities: capabilitiesFor(role) })),
      changeProcess: 'Membership and roles change only through a reviewed deployment of STAFF_ROLES. The console cannot grant access.',
    };
  }

  async settingsView() {
    const [migrations, killSwitches] = await Promise.all([
      this.pool.query<{ name: string; applied_at: Date }>('select name, applied_at from obiba_migrations.applied order by name').then((r) => ({ ok: true as const, rows: r.rows.map((m) => ({ name: m.name, appliedAt: iso(m.applied_at) })) })).catch(() => ({ ok: false as const, rows: [] })),
      this.killSwitchState(),
    ]);
    return {
      observedAt: new Date().toISOString(),
      release: this.settings.release,
      entity: this.settings.entity,
      network: this.settings.network,
      controls: killSwitches,
      migrations,
      references: [
        { name: 'Database', value: 'DATABASE_URL (Secret Manager reference; value never shown)' },
        { name: 'Queue store', value: 'REDIS_URL (Secret Manager reference; value never shown)' },
        { name: 'Staff identity', value: 'Identity-Aware Proxy' },
        { name: 'NEAR RPC', value: this.settings.rpcUrl ? new URL(this.settings.rpcUrl).host : 'Not configured' },
        { name: 'Guardian', value: this.settings.guardianUrl ? new URL(this.settings.guardianUrl).host : 'Not configured' },
      ],
      recovery: {
        backups: { state: 'NOT_CONFIGURED', note: 'Cloud SQL backups and restore drills are not attested to this console yet.' },
        restoreDrill: { state: 'NOT_CONFIGURED', note: 'No restore drill result has been recorded.' },
        keyCustody: { state: 'NOT_CONFIGURED', note: 'Recovery key custody attestation is not recorded.' },
        policy: 'Restore and backup deletion are not dashboard actions. They follow the separately controlled recovery procedure.',
      },
    };
  }

  async report(actor: string, kind: string, body: { from?: unknown; to?: unknown; purpose?: unknown }) {
    const from = timeOf(body?.from);
    const to = timeOf(body?.to);
    const purpose = reason(body?.purpose);
    if (!from || !to || Date.parse(to) <= Date.parse(from)) throw new AdminError(400, 'a valid date range is required');
    if (Date.parse(to) - Date.parse(from) > 92 * 86_400_000) throw new AdminError(400, 'the range is limited to 92 days');
    const snapshot = (await this.pool.query<{ now: Date }>('select now()')).rows[0]!.now;
    let columns: string[];
    let rows: (string | number | null)[][];
    let definition: string;
    if (kind === 'transactions') {
      const r = await this.pool.query<{ day: Date; type: string; phase: string; currency: string; n: string; amount: string }>(
        `select date_trunc('day', created_at at time zone 'UTC') as day, type, ${PHASE_SQL} as phase, currency, count(*)::text as n, sum(amount::numeric)::text as amount
           from (${TX_SQL}) t where created_at >= $1 and created_at < $2 group by 1, 2, 3, 4 order by 1, 2, 3, 4`,
        [from, to],
      );
      columns = ['day_utc', 'type', 'outcome', 'currency', 'count', 'amount_base_units', 'decimals'];
      rows = r.rows.map((x) => [new Date(x.day).toISOString().slice(0, 10), x.type, x.phase, x.currency, Number(x.n), x.amount, ASSETS[x.currency]?.decimals ?? null]);
      definition = 'One row per UTC day, operation type, outcome and currency. Amounts are integer base units of the currency, never converted. Outcome follows the console phase mapping.';
    } else if (kind === 'reconciliation') {
      const r = await this.pool.query<{ checked_at: Date; account_id: string; token: string; ledger_posted: string; chain_balance: string; matched: boolean }>(
        'select checked_at, account_id, token, ledger_posted::text, chain_balance::text, matched from ops.reconciliation_runs where checked_at >= $1 and checked_at < $2 order by checked_at limit 50000',
        [from, to],
      );
      columns = ['checked_at_utc', 'account', 'tokens', 'ledger_base_units', 'chain_base_units', 'difference_base_units', 'matched'];
      rows = r.rows.map((x) => [iso(x.checked_at), x.account_id, x.token, x.ledger_posted, x.chain_balance, (BigInt(x.chain_balance) - BigInt(x.ledger_posted)).toString(), x.matched ? 'yes' : 'no']);
      definition = 'Every reconciliation run in the range. Difference is chain minus ledger in USDC base units (6 decimals).';
    } else if (kind === 'access') {
      const r = await this.pool.query<{ at: Date; actor: string; action: string; target: string | null; outcome: string }>(
        "select at, actor, action, target, outcome from audit.log where actor like 'staff:%' and at >= $1 and at < $2 order by at limit 50000",
        [from, to],
      );
      columns = ['at_utc', 'staff', 'action', 'target', 'outcome'];
      rows = r.rows.map((x) => [iso(x.at), x.actor.slice(6), x.action, x.target, x.outcome]);
      definition = 'Every staff action recorded in the audit log in the range, for access review.';
    } else throw new AdminError(404, 'unknown report');
    const csv = [columns.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';
    const sha256 = createHash('sha256').update(csv).digest('hex');
    const filters = { from, to };
    await this.record(actor, 'report.export', kind, { filters, purpose, rows: rows.length, sha256, schemaVersion: 1 });
    return { kind, schemaVersion: 1, definition, filters, snapshotAt: iso(snapshot), generatedBy: actor, rows: rows.length, columns, preview: rows.slice(0, 50), csv, sha256 };
  }
  async incidents(query: Record<string, unknown>) {
    const status = oneOf(query.status, ['open', 'OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED'] as const);
    const r = await this.pool.query<IncidentRow>(
      `select * from ops.incidents where ($1::text is null or ($1 = 'open' and status <> 'RESOLVED') or status = $1)
        order by case status when 'RESOLVED' then 1 else 0 end, case severity when 'CRITICAL' then 0 when 'HIGH' then 1 when 'MEDIUM' then 2 else 3 end, created_at desc limit 200`,
      [status],
    );
    return { observedAt: new Date().toISOString(), rows: r.rows.map(incidentOut) };
  }

  async incident(id: string) {
    if (!UUID.test(id)) throw new AdminError(400, 'invalid incident');
    const i = (await this.pool.query<IncidentRow>('select * from ops.incidents where id = $1', [id])).rows[0];
    if (!i) throw new AdminError(404, 'incident not found');
    const ev = await this.pool.query<{ id: string; at: Date; actor: string; kind: string; body: string; evidence: string | null }>('select id::text, at, actor, kind, body, evidence from ops.incident_events where incident_id = $1 order by id', [id]);
    return { ...incidentOut(i), events: ev.rows.map((e) => ({ ...e, at: iso(e.at) })) };
  }

  async declareIncident(actor: string, body: Record<string, unknown>) {
    const title = text(body.title, 4, 140, 'title');
    const summary = text(body.summary, 8, 2000, 'summary');
    const severity = oneOf(body.severity, ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const);
    if (!severity) throw new AdminError(400, 'severity is required');
    const signalKey = body.signalKey === undefined || body.signalKey === null || body.signalKey === '' ? null : typeof body.signalKey === 'string' && /^[a-z_-]{2,32}$/.test(body.signalKey) ? body.signalKey : (() => { throw new AdminError(400, 'invalid signal'); })();
    const resources = Array.isArray(body.resources) ? body.resources : [];
    if (resources.length > 20 || resources.some((x) => typeof x !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(x))) throw new AdminError(400, 'invalid resources');
    return withTx(this.pool, async (c) => {
      const i = (await c.query<IncidentRow>('insert into ops.incidents(title, severity, summary, signal_key, resources, declared_by) values ($1, $2, $3, $4, $5, $6) returning *', [title, severity, summary, signalKey, resources, actor])).rows[0]!;
      await c.query("insert into ops.incident_events(incident_id, actor, kind, body) values ($1, $2, 'DECLARED', $3)", [i.id, actor, summary]);
      await c.query("insert into audit.log(actor, action, target, outcome, details) values ($1, 'incident.declare', $2, 'ALLOWED', $3)", [`staff:${actor}`, i.id, JSON.stringify({ severity, signalKey })]);
      return incidentOut(i);
    });
  }

  async transitionIncident(actor: string, id: string, action: 'acknowledge' | 'investigate' | 'note' | 'resolve', body: Record<string, unknown>) {
    if (!UUID.test(id)) throw new AdminError(400, 'invalid incident');
    const version = timeOf(body.version);
    if (!version) throw new AdminError(400, 'the incident version is required');
    const message = text(body.body, 3, 2000, action === 'resolve' ? 'decision' : 'note');
    const evidence = body.evidence === undefined || body.evidence === '' ? null : text(body.evidence, 3, 500, 'evidence');
    if (action === 'resolve' && !evidence) throw new AdminError(400, 'resolution requires supporting evidence');
    let signalState: HealthState | null = null;
    const current = (await this.pool.query<{ signal_key: string | null; status: string }>('select signal_key, status from ops.incidents where id = $1', [id])).rows[0];
    if (!current) throw new AdminError(404, 'incident not found');
    if (action === 'resolve' && current.status === 'OPEN') throw new AdminError(409, 'an unacknowledged incident cannot be resolved');
    if (action === 'resolve' && current.signal_key) {
      const o = await this.overview('24h');
      signalState = o.signals.find((s) => s.key === current.signal_key)?.state ?? null;
      if (signalState === 'CRITICAL' || signalState === 'STALE') throw new AdminError(409, `the linked signal is still ${signalState.toLowerCase()}; resolve the condition before closing the incident`);
    }
    return withTx(this.pool, async (c) => {
      const i = (await c.query<IncidentRow>('select * from ops.incidents where id = $1 for update', [id])).rows[0];
      if (!i) throw new AdminError(404, 'incident not found');
      if (new Date(i.updated_at).toISOString() !== version) throw new AdminError(409, 'the incident changed since you loaded it; review it again');
      if (i.status === 'RESOLVED') throw new AdminError(409, 'the incident is already resolved');
      let kind: string;
      if (action === 'acknowledge') {
        if (i.status !== 'OPEN') throw new AdminError(409, 'the incident is already acknowledged');
        await c.query("update ops.incidents set status = 'ACKNOWLEDGED', owner = $2, acknowledged_by = $2, acknowledged_at = now(), updated_at = now() where id = $1", [id, actor]);
        kind = 'ACKNOWLEDGED';
      } else if (action === 'investigate') {
        if (i.status !== 'ACKNOWLEDGED') throw new AdminError(409, 'acknowledge the incident before starting the investigation');
        await c.query("update ops.incidents set status = 'INVESTIGATING', updated_at = now() where id = $1", [id]);
        kind = 'INVESTIGATING';
      } else if (action === 'resolve') {
        if (i.status === 'OPEN') throw new AdminError(409, 'an unacknowledged incident cannot be resolved');
        await c.query("update ops.incidents set status = 'RESOLVED', resolved_by = $2, resolved_at = now(), resolution = $3, updated_at = now() where id = $1", [id, actor, message]);
        kind = 'RESOLVED';
      } else {
        await c.query('update ops.incidents set updated_at = now() where id = $1', [id]);
        kind = 'NOTE';
      }
      await c.query('insert into ops.incident_events(incident_id, actor, kind, body, evidence) values ($1, $2, $3, $4, $5)', [id, actor, kind, message, evidence]);
      await c.query("insert into audit.log(actor, action, target, outcome, details) values ($1, $2, $3, 'ALLOWED', $4)", [`staff:${actor}`, `incident.${action}`, id, JSON.stringify({ evidence: !!evidence, signalState })]);
      return { id, status: kind === 'NOTE' ? i.status : kind };
    });
  }
}

export function capabilitiesFor(role: StaffRole): string[] {
  const viewer = ['overview.read', 'transactions.read', 'customers.read.masked', 'ledger.read', 'treasury.read', 'providers.read', 'jobs.read', 'cases.read'];
  const operator = [...viewer, 'customers.search.contact', 'customers.reveal', 'cases.verify', 'review.resolve', 'incidents.manage', 'controls.pause', 'audit.read', 'reports.export'];
  const admin = [...operator, 'cases.approve', 'accounts.restrict', 'pilot.approve', 'staff.read'];
  return role === 'admin' ? admin : role === 'operator' ? operator : viewer;
}

function reviewTargets(type: string): string[] {
  if (type === 'deposit') return ['CREDITED', 'REFUNDED', 'FAILED'];
  if (type === 'withdrawal') return ['COMPLETED', 'REFUNDED'];
  if (type === 'invoice_payment') return ['COMPLETED', 'REFUNDED'];
  return ['SUCCEEDED', 'FAILED'];
}
