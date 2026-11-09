import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { withTx } from '@obiba/db';
import { publishUserEvents, type EventPublisher } from '@obiba/domain';
import {
  DEFAULT_RELAY_METHODS,
  RpcError,
  actions,
  buildSignedTx,
  checkRelayable,
  isFailure,
  signedDelegateAction,
  type FinalTxStatus,
  type NearRpc,
  type NonceSource,
  type Signer,
  type StorageSponsor,
} from '@obiba/near';
import type { Budget } from './core';

const BEGIN_GAS = 30_000_000_000_000n;
const COMPLETE_GAS = 150_000_000_000_000n;
const RECOVERY_TXS_PER_USER_PER_DAY = 6;
const MIDWAY_NS = 24n * 3_600_000_000_000n;

export interface RecoveryConfig {
  relayerAccount: string;
  accountSuffix: string;
  maxGas: bigint;
}

interface RecoveryRow {
  id: string;
  uid: string;
  account_id: string;
  new_public_key: string;
  status: string;
  guardian_sig: string | null;
  guardian_nonce: string | null;
  cancel_delegate: string | null;
  executable_at: Date | null;
  tx_hashes: string[];
  stale: boolean;
}

interface ChainPolicy {
  devices: string[];
  recovery: { new_key: string; executable_at_ns: string } | null;
}

export type RecoveryOutcome = 'submitted' | 'pending' | 'completed' | 'cancelled' | 'failed' | 'skipped' | 'over_budget';

function succeeded(status: FinalTxStatus): boolean {
  return !isFailure(status.status) && status.receipts_outcome.every((r) => !isFailure(r.outcome.status));
}

export class RecoveryRunner {
  constructor(
    private readonly pool: Pool,
    private readonly rpc: NearRpc,
    private readonly signer: Signer,
    private readonly nonces: NonceSource,
    private readonly budget: Budget,
    private readonly cfg: RecoveryConfig,
    private readonly log: Logger,
    private readonly publisher: EventPublisher,
    private readonly sponsor: StorageSponsor,
  ) {}

  private async load(id: string): Promise<RecoveryRow | null> {
    const r = await this.pool.query<RecoveryRow>(
      `select id, uid, account_id, new_public_key, status, guardian_sig, guardian_nonce::text, cancel_delegate, executable_at, tx_hashes,
              updated_at < now() - interval '2 minutes' as stale
         from ops.recoveries where id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  private async policy(accountId: string): Promise<ChainPolicy> {
    return this.rpc.view<ChainPolicy>(accountId, 'get_policy', {});
  }

  private async send(rec: RecoveryRow, method: string, args: Record<string, unknown> | null, gas: bigint, delegate?: string): Promise<FinalTxStatus | null> {
    const day = new Date().toISOString().slice(0, 10);
    if (!(await this.budget.take(`recovery:${rec.uid}:${day}`, RECOVERY_TXS_PER_USER_PER_DAY, 172_800))) return null;
    await this.sponsor.ensure(rec.account_id, method);
    const action = delegate ? signedDelegateAction(delegate) : actions.functionCall(method, args ?? {}, gas, 0n);
    const tx = await buildSignedTx(this.rpc, this.signer, this.nonces, this.cfg.relayerAccount, rec.account_id, [action]);
    await this.pool.query('update ops.recoveries set tx_hashes = array_append(tx_hashes, $2), updated_at = now() where id = $1', [rec.id, tx.hash]);
    try {
      return await this.rpc.sendTx(tx.signedBase64, 'FINAL');
    } catch (err) {
      if (err instanceof RpcError && /InvalidNonce|INVALID_TRANSACTION/.test(err.message)) {
        await this.nonces.reset(this.cfg.relayerAccount, await this.signer.publicKey());
        throw err;
      }
      this.log.warn({ recovery: rec.id, tx: tx.hash }, 'recovery transaction outcome unknown; will re-check');
      return null;
    }
  }

  private async finish(rec: RecoveryRow, status: 'FAILED' | 'CANCELLED' | 'COMPLETED' | 'PENDING_TIMELOCK', extra: { reason?: string; executableAt?: Date } = {}): Promise<void> {
    await withTx(this.pool, async (c) => {
      const r = await c.query(
        'update ops.recoveries set status = $3, reason = coalesce($4, reason), executable_at = coalesce($5, executable_at), updated_at = now() where id = $1 and status = $2',
        [rec.id, rec.status, status, extra.reason ?? null, extra.executableAt ?? null],
      );
      if (!r.rowCount) return;
      if (status === 'FAILED' || status === 'CANCELLED') {
        await c.query("update identity.devices set status = 'revoked' where uid = $1 and public_key = $2 and status = 'pending'", [rec.uid, rec.new_public_key]);
      }
      if (status === 'COMPLETED') {
        await c.query("update identity.devices set status = 'revoked' where uid = $1 and public_key <> $2 and status <> 'revoked'", [rec.uid, rec.new_public_key]);
        await c.query("update identity.devices set status = 'active' where uid = $1 and public_key = $2", [rec.uid, rec.new_public_key]);
      }
      const kind = status === 'PENDING_TIMELOCK' ? 'RECOVERY_STARTED' : `RECOVERY_${status}`;
      const n = await c.query('insert into ops.notifications(uid, kind, ref) values ($1, $2, $3) on conflict do nothing', [rec.uid, kind, rec.id]);
      if (n.rowCount) await c.query("insert into infra.outbox(topic, payload) values ('notify.email', $1)", [JSON.stringify({ uid: rec.uid, kind, ref: rec.id })]);
      await c.query("insert into audit.log(actor, action, target, outcome, details) values ('worker', 'recovery.track', $1, $2, $3)", [
        rec.id,
        status === 'FAILED' ? 'FAILED' : 'ALLOWED',
        JSON.stringify({ to: status, ...(extra.reason ? { reason: extra.reason } : {}) }),
      ]);
    });
    const event = status === 'PENDING_TIMELOCK' ? 'RECOVERY_STARTED' : `RECOVERY_${status}`;
    await publishUserEvents(this.publisher, [{ uid: rec.uid, kind: 'account', id: rec.id, status: event }]);
  }

  private async started(rec: RecoveryRow): Promise<RecoveryOutcome> {
    const p = await this.policy(rec.account_id);
    if (p.recovery?.new_key !== rec.new_public_key) return 'pending';
    await this.finish(rec, 'PENDING_TIMELOCK', { executableAt: new Date(Number(BigInt(p.recovery.executable_at_ns) / 1_000_000n)) });
    return 'submitted';
  }

  async submit(id: string): Promise<RecoveryOutcome> {
    const rec = await this.load(id);
    if (!rec || rec.status !== 'SIGNED' || !rec.guardian_sig || !rec.guardian_nonce) return 'skipped';
    const claimed = await this.pool.query("update ops.recoveries set status = 'SUBMITTED', updated_at = now() where id = $1 and status = 'SIGNED'", [rec.id]);
    if (!claimed.rowCount) return 'skipped';
    rec.status = 'SUBMITTED';
    const status = await this.send(rec, 'begin_recovery', { new_key: rec.new_public_key, guardian_sig: rec.guardian_sig, guardian_nonce: rec.guardian_nonce }, BEGIN_GAS);
    if (status === null) return 'pending';
    if (!succeeded(status)) {
      await this.finish(rec, 'FAILED', { reason: 'begin_recovery_failed' });
      return 'failed';
    }
    return this.started(rec);
  }

  async cancel(id: string): Promise<RecoveryOutcome> {
    const rec = await this.load(id);
    if (!rec || rec.status !== 'CANCEL_REQUESTED' || !rec.cancel_delegate) return 'skipped';
    const check = checkRelayable(rec.cancel_delegate, { accountSuffix: this.cfg.accountSuffix, allowedMethods: DEFAULT_RELAY_METHODS, maxGas: this.cfg.maxGas });
    if (!check.ok || check.sender !== rec.account_id || check.method !== 'cancel_recovery') {
      await this.pool.query("update ops.recoveries set status = 'PENDING_TIMELOCK', cancel_delegate = null, reason = 'cancel_rejected', updated_at = now() where id = $1 and status = 'CANCEL_REQUESTED'", [rec.id]);
      return 'failed';
    }
    const status = await this.send(rec, 'cancel_recovery', null, 0n, rec.cancel_delegate);
    if (status === null) return 'pending';
    const p = await this.policy(rec.account_id);
    if (p.recovery === null) {
      await this.finish(rec, 'CANCELLED', { reason: 'cancelled_by_device' });
      return 'cancelled';
    }
    await this.pool.query("update ops.recoveries set status = 'PENDING_TIMELOCK', cancel_delegate = null, reason = 'cancel_failed', updated_at = now() where id = $1 and status = 'CANCEL_REQUESTED'", [rec.id]);
    return 'failed';
  }

  async tick(limit = 20): Promise<number> {
    const ids = (
      await this.pool.query<{ id: string }>(
        "select id from ops.recoveries where status in ('SUBMITTED', 'PENDING_TIMELOCK', 'CANCEL_REQUESTED') order by updated_at limit $1",
        [limit],
      )
    ).rows;
    let progressed = 0;
    for (const { id } of ids) {
      try {
        const rec = await this.load(id);
        if (!rec) continue;
        const r = await this.step(rec);
        if (r !== 'pending' && r !== 'skipped') progressed++;
      } catch (err) {
        this.log.warn({ recovery: id, err: (err as Error).message }, 'recovery step failed');
      }
    }
    return progressed;
  }

  private async keysReplaced(rec: RecoveryRow): Promise<boolean> {
    const keys = await this.rpc.viewAccessKeyList(rec.account_id);
    return keys.length === 1 && keys[0]!.public_key === rec.new_public_key;
  }

  private async step(rec: RecoveryRow): Promise<RecoveryOutcome> {
    if (rec.status === 'SUBMITTED') return rec.stale ? this.started(rec) : 'pending';
    if (rec.status === 'CANCEL_REQUESTED') return rec.stale ? this.cancel(rec.id) : 'pending';
    if (rec.status !== 'PENDING_TIMELOCK') return 'skipped';
    const p = await this.policy(rec.account_id);
    if (p.recovery === null) {
      if (p.devices.length === 1 && p.devices[0] === rec.new_public_key) {
        if (!(await this.keysReplaced(rec))) return 'pending';
        await this.finish(rec, 'COMPLETED');
        return 'completed';
      }
      await this.finish(rec, 'CANCELLED', { reason: 'cancelled_on_chain' });
      return 'cancelled';
    }
    if (p.recovery.new_key !== rec.new_public_key) {
      await this.finish(rec, 'FAILED', { reason: 'different_recovery_on_chain' });
      return 'failed';
    }
    const ready = BigInt(p.recovery.executable_at_ns);
    const now = (await this.rpc.finalBlock()).timestampNs;
    if (ready - now <= MIDWAY_NS) {
      const inserted = await withTx(this.pool, async (c) => {
        const n = await c.query("insert into ops.notifications(uid, kind, ref) values ($1, 'RECOVERY_MIDWAY', $2) on conflict do nothing", [rec.uid, rec.id]);
        if (n.rowCount) await c.query("insert into infra.outbox(topic, payload) values ('notify.email', $1)", [JSON.stringify({ uid: rec.uid, kind: 'RECOVERY_MIDWAY', ref: rec.id })]);
        return (n.rowCount ?? 0) > 0;
      });
      if (inserted) await publishUserEvents(this.publisher, [{ uid: rec.uid, kind: 'account', id: rec.id, status: 'RECOVERY_MIDWAY' }]);
    }
    if (ready > now) return 'pending';
    const status = await this.send(rec, 'complete_recovery', {}, COMPLETE_GAS);
    if (status === null) return 'pending';
    const after = await this.policy(rec.account_id);
    if (after.recovery === null && after.devices.length === 1 && after.devices[0] === rec.new_public_key && (await this.keysReplaced(rec))) {
      await this.finish(rec, 'COMPLETED');
      return 'completed';
    }
    return 'pending';
  }
}
