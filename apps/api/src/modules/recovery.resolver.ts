import { Inject } from '@nestjs/common';
import { Args, Context, Field, ID, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import type { Pool } from 'pg';
import { withUserTx } from '@obiba/db';
import { ed25519KeyBytes, recoveryKitChallenge, recoveryMethodFor, recoveryKitRegistrationMessage, verifyEd25519 } from '@obiba/domain';
import { APP_CONFIG, type AppConfig } from '../config';
import { notifyUser } from '../infra/notify';
import { checkSignedDelegate } from '@obiba/near';
import { appError } from '../errors';
import { AuditService } from '../infra/audit';
import { GuardianClient } from '../infra/guardian-client';
import { NearChain } from '../infra/near-chain';
import { PG_POOL } from '../infra/tokens';
import { RateLimit, RequireFreshSession } from '../security/decorators';
import { identityOf, type ObibaRequest } from '../security/request';

const CANCEL_ARGS = Buffer.from('{}');
const CANCEL_MAX_GAS = 150_000_000_000_000n;
const MAX_BLOCK_WINDOW = 600n;
const ACTIVE = ['REQUESTED', 'SIGNED', 'SUBMITTED', 'PENDING_TIMELOCK', 'CANCEL_REQUESTED'];

@ObjectType()
export class RecoveryView {
  @Field(() => ID) recoveryId!: string;
  @Field() status!: string;
  @Field() newPublicKey!: string;
  @Field(() => String, { nullable: true }) executableAt!: string | null;
  @Field(() => String, { nullable: true }) reason!: string | null;
  @Field() createdAt!: string;
}

@ObjectType()
export class RecoveryKitStatus {
  @Field() active!: boolean;
  @Field(() => String, { nullable: true }) publicKey!: string | null;
  @Field(() => String, { nullable: true }) createdAt!: string | null;
}

@ObjectType()
export class RecoveryChallenge {
  @Field() accountId!: string;
  @Field() messageBase64!: string;
}

const SIG = /^[A-Za-z0-9+/]{86}==$/;

@ObjectType()
export class CancelRecoveryCall {
  @Field() accountId!: string;
  @Field() methodName!: string;
  @Field() argsBase64!: string;
}

interface RecoveryRow {
  id: string;
  status: string;
  new_public_key: string;
  executable_at: Date | null;
  reason: string | null;
  created_at: Date;
}

const COLUMNS = 'id, status, new_public_key, executable_at, reason, created_at';

function toView(r: RecoveryRow): RecoveryView {
  return {
    recoveryId: r.id,
    status: r.status,
    newPublicKey: r.new_public_key,
    executableAt: r.executable_at ? new Date(r.executable_at).toISOString() : null,
    reason: r.reason,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

@Resolver()
export class RecoveryResolver {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly guardian: GuardianClient,
    private readonly chain: NearChain,
    private readonly audit: AuditService,
  ) {}

  @Query(() => RecoveryView, { nullable: true })
  async recovery(@Context('req') req: ObibaRequest): Promise<RecoveryView | null> {
    const { uid } = identityOf(req);
    const r = await withUserTx(this.pool, uid, (c) => c.query<RecoveryRow>(`select ${COLUMNS} from ops.recoveries order by created_at desc limit 1`));
    return r.rows[0] ? toView(r.rows[0]) : null;
  }

  @Query(() => RecoveryKitStatus)
  async recoveryKit(@Context('req') req: ObibaRequest): Promise<RecoveryKitStatus> {
    const { uid } = identityOf(req);
    const r = await withUserTx(this.pool, uid, (c) =>
      c.query<{ public_key: string; created_at: Date }>("select public_key, created_at from identity.recovery_kits where uid = $1 and status = 'active'", [uid]),
    );
    const k = r.rows[0];
    return { active: !!k, publicKey: k?.public_key ?? null, createdAt: k ? new Date(k.created_at).toISOString() : null };
  }

  @Mutation(() => RecoveryKitStatus)
  @RequireFreshSession()
  @RateLimit('recovery_kit')
  async registerRecoveryKit(
    @Context('req') req: ObibaRequest,
    @Args('kitPublicKey') kitPublicKey: string,
    @Args('devicePublicKey') devicePublicKey: string,
    @Args('deviceSignature') deviceSignature: string,
  ): Promise<RecoveryKitStatus> {
    const { uid } = identityOf(req);
    for (const [field, key] of [['kitPublicKey', kitPublicKey], ['devicePublicKey', devicePublicKey]] as const) {
      try {
        ed25519KeyBytes(key);
      } catch {
        throw appError('BAD_INPUT', field);
      }
    }
    if (kitPublicKey === devicePublicKey) throw appError('BAD_INPUT', 'kitPublicKey');
    if (!SIG.test(deviceSignature)) throw appError('BAD_INPUT', 'deviceSignature');
    const accountId = await withUserTx(this.pool, uid, async (c) => {
      const d = await c.query("select 1 from identity.devices where uid = $1 and public_key = $2 and status = 'active'", [uid, devicePublicKey]);
      if (!d.rowCount) throw appError('FORBIDDEN', 'devicePublicKey');
      const a = await c.query<{ account_id: string }>("select account_id from chain.accounts where uid = $1 and status in ('active', 'frozen')", [uid]);
      if (!a.rows[0]) throw appError('FORBIDDEN');
      return a.rows[0].account_id;
    });
    if (!verifyEd25519(devicePublicKey, recoveryKitRegistrationMessage(this.config.NEAR_NETWORK, accountId, kitPublicKey), Buffer.from(deviceSignature, 'base64'))) {
      await this.audit.record({ actor: uid, action: 'recovery_kit.register', outcome: 'DENIED', requestId: req.requestId, details: { reason: 'device_signature' } });
      throw appError('SIGNED_OP_MISMATCH');
    }
    let onChain: bigint | null;
    try {
      onChain = await this.chain.accessKeyNonce(accountId, devicePublicKey);
    } catch {
      throw appError('SERVICE_PAUSED');
    }
    if (onChain === null) throw appError('FORBIDDEN', 'devicePublicKey');
    try {
      return await withUserTx(this.pool, uid, async (c) => {
        const replaced = await c.query("update identity.recovery_kits set status = 'replaced', replaced_at = now() where uid = $1 and status = 'active' returning id", [uid]);
        const r = await c.query<{ public_key: string; created_at: Date }>(
          "insert into identity.recovery_kits(uid, public_key, registered_by_device, device_signature, status) values ($1, $2, $3, $4, 'active') returning public_key, created_at",
          [uid, kitPublicKey, devicePublicKey, deviceSignature],
        );
        const kind = replaced.rowCount ? 'RECOVERY_KIT_REPLACED' : 'RECOVERY_KIT_CREATED';
        await notifyUser(c, uid, kind, r.rows[0]!.public_key.slice(-16), true);
        await this.audit.record({ actor: uid, action: 'recovery_kit.register', target: kitPublicKey, outcome: 'ALLOWED', requestId: req.requestId, details: { replaced: !!replaced.rowCount } }, c);
        return { active: true, publicKey: r.rows[0]!.public_key, createdAt: new Date(r.rows[0]!.created_at).toISOString() };
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw appError('CONFLICT', 'kitPublicKey');
      throw err;
    }
  }

  @Query(() => RecoveryChallenge)
  @RateLimit('lookup')
  async recoveryChallenge(@Context('req') req: ObibaRequest, @Args('newPublicKey') newPublicKey: string): Promise<RecoveryChallenge> {
    const { uid } = identityOf(req);
    try {
      ed25519KeyBytes(newPublicKey);
    } catch {
      throw appError('BAD_INPUT', 'newPublicKey');
    }
    const a = await withUserTx(this.pool, uid, (c) => c.query<{ account_id: string }>("select account_id from chain.accounts where uid = $1 and status in ('active', 'frozen')", [uid]));
    const accountId = a.rows[0]?.account_id;
    if (!accountId) throw appError('FORBIDDEN');
    let nonce: string | undefined;
    try {
      nonce = (await this.chain.policy(accountId)).guardian_nonce;
    } catch {
      throw appError('SERVICE_PAUSED');
    }
    if (!nonce || !/^\d{1,20}$/.test(String(nonce))) throw appError('SERVICE_PAUSED');
    return { accountId, messageBase64: Buffer.from(recoveryKitChallenge(this.config.NEAR_NETWORK, accountId, newPublicKey, String(nonce))).toString('base64') };
  }

  @Mutation(() => RecoveryView)
  @RequireFreshSession()
  @RateLimit('recovery_start')
  async startRecovery(
    @Context('req') req: ObibaRequest,
    @Args('newPublicKey') newPublicKey: string,
    @Args('kitSignature', { type: () => String, nullable: true }) kitSignature: string | null,
  ): Promise<RecoveryView> {
    const identity = identityOf(req);
    const uid = identity.uid;
    try {
      ed25519KeyBytes(newPublicKey);
    } catch {
      throw appError('BAD_INPUT', 'newPublicKey');
    }
    if (kitSignature != null && !SIG.test(kitSignature)) throw appError('BAD_INPUT', 'kitSignature');
    const method = kitSignature != null ? 'KIT' : recoveryMethodFor(identity.secondFactor);
    if (!method) throw appError('STEP_UP_REQUIRED');
    const idToken = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!idToken) throw appError('UNAUTHENTICATED');
    const created = await withUserTx(this.pool, uid, async (c) => {
      const a = await c.query<{ account_id: string; status: string }>('select account_id, status from chain.accounts where uid = $1', [uid]);
      const account = a.rows[0];
      if (!account || !['active', 'frozen'].includes(account.status)) throw appError('FORBIDDEN');
      const busy = await c.query('select 1 from ops.recoveries where status = any($1) for update', [ACTIVE]);
      if (busy.rowCount) throw appError('CONFLICT');
      try {
        await c.query("insert into identity.devices(uid, public_key, initial, status) values ($1, $2, false, 'pending')", [uid, newPublicKey]);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw appError('CONFLICT', 'newPublicKey');
        throw err;
      }
      const r = await c.query<RecoveryRow>(
        `insert into ops.recoveries(uid, account_id, new_public_key, status, method, kit_signature) values ($1, $2, $3, 'REQUESTED', $4, $5) returning ${COLUMNS}`,
        [uid, account.account_id, newPublicKey, method, kitSignature ?? null],
      );
      await this.audit.record({ actor: uid, action: 'recovery.request', target: r.rows[0]!.id, outcome: 'ALLOWED', requestId: req.requestId }, c);
      return r.rows[0]!;
    });
    let result;
    try {
      result = await this.guardian.recovery(created.id, idToken, kitSignature ?? null);
    } catch {
      result = { ok: false as const, reason: 'guardian_unavailable' };
    }
    return withUserTx(this.pool, uid, async (c) => {
      if (!result.ok) {
        const r = await c.query<RecoveryRow>(
          `update ops.recoveries set status = 'FAILED', reason = $2, updated_at = now() where id = $1 and status = 'REQUESTED' returning ${COLUMNS}`,
          [created.id, result.reason.slice(0, 200)],
        );
        await c.query("update identity.devices set status = 'revoked' where uid = $1 and public_key = $2 and status = 'pending'", [uid, newPublicKey]);
        await notifyUser(c, uid, 'RECOVERY_FAILED', created.id, true);
        await this.audit.record({ actor: uid, action: 'recovery.cosign', target: created.id, outcome: 'DENIED', requestId: req.requestId, details: { reason: result.reason.slice(0, 200) } }, c);
        return toView(r.rows[0] ?? created);
      }
      if (!/^\d{1,20}$/.test(result.guardianNonce) || !/^[A-Za-z0-9+/]{86}==$/.test(result.signature)) throw appError('SERVICE_PAUSED');
      const r = await c.query<RecoveryRow>(
        `update ops.recoveries set status = 'SIGNED', guardian_sig = $2, guardian_nonce = $3, updated_at = now() where id = $1 and status = 'REQUESTED' returning ${COLUMNS}`,
        [created.id, result.signature, result.guardianNonce],
      );
      if (!r.rows[0]) throw appError('CONFLICT');
      await c.query("insert into infra.outbox(topic, payload) values ('recovery.submit', $1)", [JSON.stringify({ recovery_id: created.id })]);
      await notifyUser(c, uid, 'RECOVERY_REQUESTED', created.id, true);
      await this.audit.record({ actor: uid, action: 'recovery.cosign', target: created.id, outcome: 'ALLOWED', requestId: req.requestId }, c);
      return toView(r.rows[0]);
    });
  }

  @Query(() => CancelRecoveryCall)
  async cancelRecoveryCall(@Context('req') req: ObibaRequest): Promise<CancelRecoveryCall> {
    const { uid } = identityOf(req);
    const a = await withUserTx(this.pool, uid, (c) => c.query<{ account_id: string }>('select account_id from chain.accounts where uid = $1', [uid]));
    if (!a.rows[0]) throw appError('FORBIDDEN');
    return { accountId: a.rows[0].account_id, methodName: 'cancel_recovery', argsBase64: CANCEL_ARGS.toString('base64') };
  }

  @Mutation(() => RecoveryView)
  @RateLimit('money')
  async cancelRecovery(@Context('req') req: ObibaRequest, @Args('signedDelegate') signedDelegate: string): Promise<RecoveryView> {
    const { uid } = identityOf(req);
    if (typeof signedDelegate !== 'string' || signedDelegate.length > 12_000) throw appError('BAD_INPUT', 'signedDelegate');
    let height: bigint;
    try {
      height = await this.chain.finalBlockHeight();
    } catch {
      throw appError('SERVICE_PAUSED');
    }
    return withUserTx(this.pool, uid, async (c) => {
      const r = await c.query<RecoveryRow & { account_id: string }>(
        `select ${COLUMNS}, account_id from ops.recoveries where status in ('SUBMITTED', 'PENDING_TIMELOCK') for update`,
      );
      const rec = r.rows[0];
      if (!rec) throw appError('NOT_FOUND');
      const devices = await c.query<{ public_key: string }>("select public_key from identity.devices where uid = $1 and status = 'active'", [uid]);
      const check = checkSignedDelegate(signedDelegate, {
        account: rec.account_id,
        methodName: 'cancel_recovery',
        args: CANCEL_ARGS,
        devicePublicKeys: devices.rows.map((d) => d.public_key),
        maxGas: CANCEL_MAX_GAS,
        currentBlockHeight: height,
        maxBlockHeightWindow: MAX_BLOCK_WINDOW,
      });
      if (!check.ok) {
        await this.audit.record({ actor: uid, action: 'recovery.cancel', target: rec.id, outcome: 'DENIED', requestId: req.requestId, details: { reason: check.reason } }, c);
        throw appError('SIGNED_OP_MISMATCH');
      }
      const u = await c.query<RecoveryRow>(
        `update ops.recoveries set status = 'CANCEL_REQUESTED', cancel_delegate = $2, updated_at = now() where id = $1 returning ${COLUMNS}`,
        [rec.id, signedDelegate],
      );
      await c.query("insert into infra.outbox(topic, payload) values ('recovery.cancel', $1)", [JSON.stringify({ recovery_id: rec.id })]);
      await this.audit.record({ actor: uid, action: 'recovery.cancel', target: rec.id, outcome: 'ALLOWED', requestId: req.requestId }, c);
      return toView(u.rows[0]!);
    });
  }
}
