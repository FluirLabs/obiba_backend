import type { Pool } from 'pg';
import { withTx } from '@obiba/db';
import { SUPPORT_COSIGN_LOCK_DAYS, SUPPORT_CREDENTIAL_QUIET_DAYS, SUPPORT_REVIEW_HOURS, deviceOpPreimage, guardianPreimage, isSecondFactor, supportChecksPassed, recoveryKitChallenge, recoveryKitRegistrationMessage, sha256, usdUnits, verifyEd25519, type Op, type TokenSpec } from '@obiba/domain';
import type { NearRpc, Signer } from '@obiba/near';

export interface GuardianIdentity {
  uid: string;
  emailVerified: boolean;
  authTime: number;
  secondFactor: string | null;
}

export interface UserTokenVerifier {
  verify(idToken: string): Promise<GuardianIdentity>;
  credentialsChangedAt(uid: string): Promise<Date | null>;
}

export interface GuardianPolicy {
  networkId: string;
  tokens: TokenSpec[];
  stepUpMaxAgeSeconds: number;
}

export type CosignResult = { ok: true; signature: string } | { ok: false; reason: string };
export type RecoveryResult = { ok: true; signature: string; guardianNonce: string } | { ok: false; reason: string };

const RECOVERY_COOLDOWN = '7 days';

interface ChainPolicy {
  guardian: string;
  guardian_nonce: string;
  devices: string[];
  recovery: unknown;
  frozen_until_ns?: string;
}

const MAX_DEVICES = 5;
const MAX_DEVICE_ADDS_PER_DAY = 3;
const DEVICE_CHANGE_MAX_AGE_SECONDS = 300;
const ED25519_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const GRANT_KINDS: Record<string, readonly string[]> = {
  add_device: ['passkey_enroll', 'passkey_signin', 'device_link'],
  remove_device: ['device_remove'],
};

interface OpRow {
  uid: string;
  account_id: string;
  status: string;
  canonical: { op: Op };
}

export class Guardian {
  private readonly decimals: Map<string, number>;

  constructor(
    private readonly pool: Pool,
    private readonly rpc: NearRpc,
    private readonly signer: Signer,
    private readonly users: UserTokenVerifier,
    private readonly policy: GuardianPolicy,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.decimals = new Map(policy.tokens.map((t) => [t.token, t.decimals]));
  }

  async cosign(opId: string, deviceSignatureB64: string, idToken: string): Promise<CosignResult> {
    if (!/^[0-9a-f]{32}$/.test(opId)) return { ok: false, reason: 'bad_request' };
    const op = (await this.pool.query<OpRow>('select uid, account_id, status, canonical from ops.prepared_ops where op_id = $1', [opId])).rows[0];
    if (!op) return this.refuse(opId, null, 0n, 'unknown_op');
    const rules: Record<string, boolean> = {};
    const o = op.canonical.op;
    const decimals = this.decimals.get(o.token);
    const usd = decimals === undefined ? 0n : usdUnits(BigInt(o.amount), decimals);

    let identity: GuardianIdentity;
    try {
      identity = await this.users.verify(idToken);
    } catch {
      return this.refuse(opId, op.uid, usd, 'identity_invalid');
    }
    const age = Math.floor(this.now() / 1000) - identity.authTime;
    rules.identity_matches = identity.uid === op.uid;
    rules.email_verified = identity.emailVerified;
    rules.fresh_sign_in = age >= 0 && age <= this.policy.stepUpMaxAgeSeconds;
    rules.op_pending = op.status === 'PREPARED';
    rules.op_not_expired = BigInt(o.expires_at_ns) > BigInt(this.now()) * 1_000_000n + 60_000_000_000n;
    rules.known_token = decimals !== undefined;
    rules.no_recent_support_recovery = await this.noRecentSupportRecovery(op.uid);

    const devices = await this.pool.query<{ public_key: string }>("select public_key from identity.devices where uid = $1 and status = 'active'", [op.uid]);
    const digest = sha256(deviceOpPreimage(this.policy.networkId, op.account_id, o));
    const sig = Buffer.from(deviceSignatureB64, 'base64');
    const signer = devices.rows.find((d) => verifyEd25519(d.public_key, digest, sig));
    rules.device_signature = signer !== undefined;
    if (signer) {
      const onChain = await this.rpc.viewAccessKey(op.account_id, signer.public_key).catch(() => null);
      const perm = onChain?.permission;
      rules.device_key_on_chain = typeof perm === 'object' && perm !== null && 'FunctionCall' in perm && perm.FunctionCall.receiver_id === op.account_id;
    } else {
      rules.device_key_on_chain = false;
    }

    const failed = Object.entries(rules).filter(([, v]) => !v).map(([k]) => k);
    if (failed.length > 0) return this.refuse(opId, op.uid, usd, failed.join(','), rules);

    const preimage = guardianPreimage(this.policy.networkId, op.account_id, { purpose: 'ExecuteOp', payload: o });
    const signature = Buffer.from(await this.signer.sign(sha256(preimage))).toString('base64');
    await withTx(this.pool, (c) =>
      c.query("insert into ops.guardian_decisions(op_id, uid, usd, outcome, rules) values ($1, $2, $3, 'SIGNED', $4)", [opId, op.uid, usd.toString(), JSON.stringify(rules)]),
    );
    return { ok: true, signature };
  }

  async recovery(recoveryId: string, idToken: string, kitSignature: string | null = null): Promise<RecoveryResult> {
    if (!/^[0-9a-f-]{36}$/.test(recoveryId)) return { ok: false, reason: 'bad_request' };
    const ref = `recovery:${recoveryId}`;
    const rec = (
      await this.pool.query<{ uid: string; account_id: string; new_public_key: string; status: string; method: string; kit_signature: string | null }>(
        'select uid, account_id, new_public_key, status, method, kit_signature from ops.recoveries where id = $1',
        [recoveryId],
      )
    ).rows[0];
    if (!rec) return this.refuse(ref, null, 0n, 'unknown_recovery');
    const rules: Record<string, boolean> = {};
    let identity: GuardianIdentity;
    try {
      identity = await this.users.verify(idToken);
    } catch {
      return this.refuse(ref, rec.uid, 0n, 'identity_invalid');
    }
    const age = Math.floor(this.now() / 1000) - identity.authTime;
    rules.identity_matches = identity.uid === rec.uid;
    rules.email_verified = identity.emailVerified;
    const freshSignIn = age >= 0 && age <= this.policy.stepUpMaxAgeSeconds;
    const useKit = rec.method === 'KIT';
    if (useKit) {
      rules.fresh_sign_in = freshSignIn;
      rules.kit_signature_matches_request = kitSignature !== null && kitSignature === rec.kit_signature;
    } else {
      rules.fresh_second_factor = isSecondFactor(identity.secondFactor) && freshSignIn;
    }
    rules.recovery_pending = rec.status === 'REQUESTED';
    const user = await this.pool.query<{ status: string }>('select status from identity.users where uid = $1', [rec.uid]);
    rules.user_active = user.rows[0]?.status === 'active';
    const device = await this.pool.query("select 1 from identity.devices where uid = $1 and public_key = $2 and status = 'pending'", [rec.uid, rec.new_public_key]);
    rules.new_device_registered = (device.rowCount ?? 0) > 0;
    const recent = await this.pool.query<{ n: string }>(
      "select count(*)::text as n from ops.guardian_decisions where uid = $1 and outcome = 'SIGNED' and op_id like 'recovery:%' and decided_at > now() - $2::interval",
      [rec.uid, RECOVERY_COOLDOWN],
    );
    rules.within_recovery_cooldown = recent.rows[0]!.n === '0';
    let chain: ChainPolicy | null = null;
    try {
      chain = await this.rpc.view<ChainPolicy>(rec.account_id, 'get_policy', {});
    } catch {
      chain = null;
    }
    rules.chain_readable = chain !== null;
    rules.no_recovery_on_chain = chain !== null && chain.recovery === null;
    rules.key_is_new = chain !== null && !chain.devices.includes(rec.new_public_key) && chain.guardian !== rec.new_public_key;
    rules.nonce_valid = chain !== null && /^\d{1,20}$/.test(String(chain.guardian_nonce));
    if (useKit) {
      const kit = (
        await this.pool.query<{ public_key: string; registered_by_device: string; device_signature: string }>(
          "select public_key, registered_by_device, device_signature from identity.recovery_kits where uid = $1 and status = 'active'",
          [rec.uid],
        )
      ).rows[0];
      rules.kit_active = kit !== undefined;
      rules.kit_registered_by_on_chain_device =
        kit !== undefined &&
        chain !== null &&
        chain.devices.includes(kit.registered_by_device) &&
        verifyEd25519(kit.registered_by_device, recoveryKitRegistrationMessage(this.policy.networkId, rec.account_id, kit.public_key), Buffer.from(kit.device_signature, 'base64'));
      rules.kit_proof_valid =
        kit !== undefined &&
        chain !== null &&
        rules.nonce_valid === true &&
        rec.kit_signature !== null &&
        verifyEd25519(kit.public_key, recoveryKitChallenge(this.policy.networkId, rec.account_id, rec.new_public_key, String(chain.guardian_nonce)), Buffer.from(rec.kit_signature, 'base64'));
    }
    const failed = Object.entries(rules).filter(([, v]) => !v).map(([k]) => k);
    if (failed.length > 0 || !chain) return this.refuse(ref, rec.uid, 0n, failed.join(',') || 'chain', rules);
    const guardianNonce = String(chain.guardian_nonce);
    const preimage = guardianPreimage(this.policy.networkId, rec.account_id, {
      purpose: 'BeginRecovery',
      payload: { public_key: rec.new_public_key, guardian_nonce: guardianNonce },
    });
    const signature = Buffer.from(await this.signer.sign(sha256(preimage))).toString('base64');
    await this.pool.query("insert into ops.guardian_decisions(op_id, uid, usd, outcome, rules) values ($1, $2, 0, 'SIGNED', $3)", [ref, rec.uid, JSON.stringify(rules)]);
    return { ok: true, signature, guardianNonce };
  }

  async deviceChange(callId: string, idToken: string): Promise<RecoveryResult> {
    if (!/^[0-9a-f]{32}$/.test(callId)) return { ok: false, reason: 'bad_request' };
    const ref = `device:${callId}`;
    const call = (
      await this.pool.query<{ uid: string; account_id: string; method: string; args_b64: string; status: string }>(
        'select uid, account_id, method, args_b64, status from ops.account_calls where call_id = $1',
        [callId],
      )
    ).rows[0];
    if (!call) return this.refuse(ref, null, 0n, 'unknown_call');
    let args: { public_key?: unknown; guardian_sig?: unknown };
    try {
      args = JSON.parse(Buffer.from(call.args_b64, 'base64').toString()) as typeof args;
    } catch {
      return this.refuse(ref, call.uid, 0n, 'bad_args');
    }
    const publicKey = typeof args.public_key === 'string' && ED25519_KEY.test(args.public_key) ? args.public_key : null;
    const adding = call.method === 'add_device';
    const rules: Record<string, boolean> = {};
    let identity: GuardianIdentity;
    try {
      identity = await this.users.verify(idToken);
    } catch {
      return this.refuse(ref, call.uid, 0n, 'identity_invalid');
    }
    const age = Math.floor(this.now() / 1000) - identity.authTime;
    rules.identity_matches = identity.uid === call.uid;
    rules.email_verified = identity.emailVerified;
    rules.fresh_session = age >= 0 && age <= DEVICE_CHANGE_MAX_AGE_SECONDS;
    rules.call_pending = call.status === 'PREPARED' && (call.method === 'add_device' || call.method === 'remove_device') && args.guardian_sig === null;
    rules.key_valid = publicKey !== null;
    const grant = (
      await this.pool.query<{ uid: string; public_key: string; kind: string; expires_at: Date }>('select uid, public_key, kind, expires_at from ops.device_grants where call_id = $1', [callId])
    ).rows[0];
    rules.grant_matches =
      grant !== undefined && grant.uid === call.uid && grant.public_key === publicKey && (GRANT_KINDS[call.method] ?? []).includes(grant.kind) && new Date(grant.expires_at).getTime() > this.now();
    const signed = await this.pool.query("select 1 from ops.guardian_decisions where op_id = $1 and outcome = 'SIGNED'", [ref]);
    rules.not_already_signed = (signed.rowCount ?? 0) === 0;
    if (adding) {
      rules.no_recent_support_recovery = await this.noRecentSupportRecovery(call.uid);
      const recent = await this.pool.query<{ n: string }>(
        "select count(*)::text as n from ops.guardian_decisions d join ops.account_calls c on d.op_id = 'device:' || c.call_id where d.uid = $1 and d.outcome = 'SIGNED' and c.method = 'add_device' and d.decided_at > now() - interval '24 hours'",
        [call.uid],
      );
      rules.within_daily_adds = Number(recent.rows[0]!.n) < MAX_DEVICE_ADDS_PER_DAY;
    }
    let chain: ChainPolicy | null = null;
    try {
      chain = await this.rpc.view<ChainPolicy>(call.account_id, 'get_policy', {});
    } catch {
      chain = null;
    }
    rules.chain_readable = chain !== null;
    rules.not_frozen = chain !== null && BigInt(chain.frozen_until_ns ?? '0') <= BigInt(this.now()) * 1_000_000n;
    rules.not_guardian_key = chain !== null && publicKey !== chain.guardian;
    if (adding) {
      rules.not_already_device = chain !== null && publicKey !== null && !chain.devices.includes(publicKey);
      rules.room_for_device = chain !== null && chain.devices.length < MAX_DEVICES;
    } else {
      rules.is_device = chain !== null && publicKey !== null && chain.devices.includes(publicKey);
      rules.not_last_device = chain !== null && chain.devices.length > 1;
    }
    const failed = Object.entries(rules).filter(([, v]) => !v).map(([k]) => k);
    if (failed.length > 0 || !chain || publicKey === null) return this.refuse(ref, call.uid, 0n, failed.join(',') || 'chain', rules);
    const guardianNonce = String(chain.guardian_nonce);
    const preimage = guardianPreimage(this.policy.networkId, call.account_id, { purpose: adding ? 'AddDevice' : 'RemoveDevice', payload: { public_key: publicKey, guardian_nonce: guardianNonce } });
    const signature = Buffer.from(await this.signer.sign(sha256(preimage))).toString('base64');
    await this.pool.query("insert into ops.guardian_decisions(op_id, uid, usd, outcome, rules) values ($1, $2, 0, 'SIGNED', $3)", [ref, call.uid, JSON.stringify({ ...rules, kind: grant?.kind })]);
    return { ok: true, signature, guardianNonce };
  }

  private async noRecentSupportRecovery(uid: string): Promise<boolean> {
    const r = await this.pool.query(
      "select 1 from ops.recoveries where uid = $1 and method = 'SUPPORT' and status = 'COMPLETED' and updated_at > now() - make_interval(days => $2)",
      [uid, SUPPORT_COSIGN_LOCK_DAYS],
    );
    return (r.rowCount ?? 0) === 0;
  }

  async supportRecovery(recoveryId: string): Promise<RecoveryResult> {
    if (!/^[0-9a-f-]{36}$/.test(recoveryId)) return { ok: false, reason: 'bad_request' };
    const ref = `recovery:${recoveryId}`;
    const rec = (
      await this.pool.query<{ uid: string; account_id: string; new_public_key: string; status: string; method: string; support_case_id: string | null }>(
        'select uid, account_id, new_public_key, status, method, support_case_id from ops.recoveries where id = $1',
        [recoveryId],
      )
    ).rows[0];
    if (!rec) return this.refuse(ref, null, 0n, 'unknown_recovery');
    const rules: Record<string, boolean> = {};
    rules.support_method = rec.method === 'SUPPORT' && rec.support_case_id !== null;
    rules.recovery_pending = rec.status === 'REQUESTED';
    const kase = rec.support_case_id
      ? (
          await this.pool.query<{ uid: string; account_id: string; new_public_key: string; status: string; checks: unknown; verified_by: string | null; approved_by: string | null; created_at: Date; recovery_id: string | null }>(
            'select uid, account_id, new_public_key, status, checks, verified_by, approved_by, created_at, recovery_id from ops.support_cases where id = $1',
            [rec.support_case_id],
          )
        ).rows[0]
      : undefined;
    const user = (await this.pool.query<{ status: string; email: string }>('select status, email from identity.users where uid = $1', [rec.uid])).rows[0];
    rules.case_found = kase !== undefined;
    rules.case_matches_recovery = kase !== undefined && kase.uid === rec.uid && kase.account_id === rec.account_id && kase.new_public_key === rec.new_public_key;
    rules.case_approved = kase?.status === 'APPROVED' && (kase.recovery_id === null || kase.recovery_id === recoveryId);
    rules.checks_passed = kase !== undefined && supportChecksPassed(kase.checks);
    rules.two_distinct_staff = !!kase?.verified_by && !!kase.approved_by && kase.verified_by.toLowerCase() !== kase.approved_by.toLowerCase();
    rules.staff_not_account_holder =
      !!user && !!kase?.verified_by && !!kase.approved_by && ![kase.verified_by, kase.approved_by].some((s) => s.toLowerCase() === user.email.toLowerCase());
    rules.review_period_elapsed = kase !== undefined && this.now() - new Date(kase.created_at).getTime() >= SUPPORT_REVIEW_HOURS * 3_600_000;
    let changed: Date | null | undefined;
    try {
      changed = await this.users.credentialsChangedAt(rec.uid);
    } catch {
      changed = undefined;
    }
    rules.credentials_readable = changed !== undefined;
    rules.credentials_unchanged = changed === null || (changed !== undefined && this.now() - changed.getTime() >= SUPPORT_CREDENTIAL_QUIET_DAYS * 86_400_000);
    rules.user_active = user?.status === 'active';
    const device = await this.pool.query("select 1 from identity.devices where uid = $1 and public_key = $2 and status = 'pending'", [rec.uid, rec.new_public_key]);
    rules.new_device_registered = (device.rowCount ?? 0) > 0;
    const recent = await this.pool.query<{ n: string }>(
      "select count(*)::text as n from ops.guardian_decisions where uid = $1 and outcome = 'SIGNED' and op_id like 'recovery:%' and decided_at > now() - $2::interval",
      [rec.uid, RECOVERY_COOLDOWN],
    );
    rules.within_recovery_cooldown = recent.rows[0]!.n === '0';
    let chain: ChainPolicy | null = null;
    try {
      chain = await this.rpc.view<ChainPolicy>(rec.account_id, 'get_policy', {});
    } catch {
      chain = null;
    }
    rules.chain_readable = chain !== null;
    rules.no_recovery_on_chain = chain !== null && chain.recovery === null;
    rules.key_is_new = chain !== null && !chain.devices.includes(rec.new_public_key) && chain.guardian !== rec.new_public_key;
    rules.nonce_valid = chain !== null && /^\d{1,20}$/.test(String(chain.guardian_nonce));
    const failed = Object.entries(rules).filter(([, v]) => !v).map(([k]) => k);
    if (failed.length > 0 || !chain) return this.refuse(ref, rec.uid, 0n, failed.join(',') || 'chain', rules);
    const guardianNonce = String(chain.guardian_nonce);
    const preimage = guardianPreimage(this.policy.networkId, rec.account_id, {
      purpose: 'BeginRecovery',
      payload: { public_key: rec.new_public_key, guardian_nonce: guardianNonce },
    });
    const signature = Buffer.from(await this.signer.sign(sha256(preimage))).toString('base64');
    await this.pool.query("insert into ops.guardian_decisions(op_id, uid, usd, outcome, rules) values ($1, $2, 0, 'SIGNED', $3)", [ref, rec.uid, JSON.stringify(rules)]);
    return { ok: true, signature, guardianNonce };
  }

  private async refuse(opId: string, uid: string | null, usd: bigint, reason: string, rules: Record<string, boolean> = {}): Promise<{ ok: false; reason: string }> {
    await this.pool.query("insert into ops.guardian_decisions(op_id, uid, usd, outcome, rules) values ($1, $2, $3, 'REFUSED', $4)", [
      opId,
      uid,
      usd.toString(),
      JSON.stringify({ ...rules, reason }),
    ]);
    return { ok: false, reason };
  }
}
