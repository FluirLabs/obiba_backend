import type { PoolClient } from 'pg';
import type { IdTokenVerifier } from '../security/identity';

export async function notifyUser(c: PoolClient, uid: string, kind: string, ref: string | null, email: boolean): Promise<void> {
  const r = await c.query('insert into ops.notifications(uid, kind, ref) values ($1, $2, $3) on conflict do nothing', [uid, kind, ref]);
  if (email && r.rowCount) await c.query("insert into infra.outbox(topic, payload) values ('notify.email', $1)", [JSON.stringify({ uid, kind, ref })]);
}

export async function hasRecoveryKit(c: PoolClient, uid: string): Promise<boolean> {
  const r = await c.query("select 1 from identity.recovery_kits where uid = $1 and status = 'active'", [uid]);
  return (r.rowCount ?? 0) > 0;
}

export async function recoverySetUp(c: PoolClient, uid: string, verifier: Pick<IdTokenVerifier, 'verifiedPhone'>): Promise<boolean> {
  if (await hasRecoveryKit(c, uid)) return true;
  const passkey = await c.query("select 1 from identity.passkeys where uid = $1 and status = 'active'", [uid]);
  if (passkey.rowCount) return true;
  return (await verifier.verifiedPhone(uid).catch(() => null)) !== null;
}
