import { Inject } from '@nestjs/common';
import { Args, Context, Field, ID, InputType, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import type { Pool } from 'pg';
import { withUserTx } from '@obiba/db';
import { ed25519KeyBytes, guardianPreimage, isHexId, newHexId, sha256, USDC_DECIMALS, verifyEd25519 } from '@obiba/domain';
import { assembleSignedDelegate, buildUnsignedDelegate, checkSignedDelegate } from '@obiba/near';
import { APP_CONFIG, explorerAccountUrl, type AppConfig } from '../config';
import { appError } from '../errors';
import { AuditService } from '../infra/audit';
import { GuardianClient } from '../infra/guardian-client';
import { localGuardianSign } from '../infra/local-guardian';
import { NearChain } from '../infra/near-chain';
import { PG_POOL } from '../infra/tokens';
import { RateLimit, RequireFreshSession } from '../security/decorators';
import { IdTokenVerifier } from '../security/identity';
import { identityOf, type ObibaRequest } from '../security/request';
import { activeAccount } from './payments.resolver';
import { tokensToEnable, usdcContracts } from './tokens';

const GAS: Record<string, bigint> = {
  execute: 50_000_000_000_000n,
  pay_invoice: 150_000_000_000_000n,
  set_limit: 30_000_000_000_000n,
  cancel_recovery: 30_000_000_000_000n,
  add_token: 30_000_000_000_000n,
  add_device: 50_000_000_000_000n,
  remove_device: 50_000_000_000_000n,
};
const MAX_GAS: Record<string, bigint> = {
  set_limit: 30_000_000_000_000n,
  add_token: 30_000_000_000_000n,
  add_device: 50_000_000_000_000n,
  remove_device: 50_000_000_000_000n,
};
const DELEGATE_TTL_BLOCKS = 200n;
const MAX_BLOCK_WINDOW = 600n;
const CANCEL_ARGS = Buffer.from('{}');

@InputType()
export class BuildDelegateInput {
  @Field(() => String, { nullable: true }) opId?: string | null;
  @Field(() => String, { nullable: true }) callId?: string | null;
  @Field(() => Boolean, { nullable: true }) cancelRecovery?: boolean | null;
  @Field() publicKey!: string;
}

@ObjectType()
export class UnsignedDelegateView {
  @Field() accountId!: string;
  @Field() methodName!: string;
  @Field() delegateBase64!: string;
  @Field() signingHashHex!: string;
  @Field() nonce!: string;
  @Field() maxBlockHeight!: string;
}

@ObjectType()
export class AccountCall {
  @Field(() => ID) callId!: string;
  @Field() accountId!: string;
  @Field() methodName!: string;
  @Field() argsBase64!: string;
  @Field() status!: string;
  @Field(() => String, { nullable: true }) newLimit!: string | null;
  @Field(() => String, { nullable: true }) token!: string | null;
  @Field(() => String, { nullable: true }) effectiveAt!: string | null;
}

@ObjectType()
export class DeviceView {
  @Field() publicKey!: string;
  @Field() status!: string;
  @Field() initial!: boolean;
  @Field() createdAt!: string;
  @Field() kind!: string;
  @Field(() => String, { nullable: true }) label!: string | null;
}

@ObjectType()
export class AccountView {
  @Field(() => String, { nullable: true }) accountId!: string | null;
  @Field(() => String, { nullable: true }) status!: string | null;
  @Field(() => String, { nullable: true }) explorerUrl!: string | null;
  @Field() network!: string;
  @Field() usdcContract!: string;
}

@ObjectType()
export class NotificationView {
  @Field(() => ID) id!: string;
  @Field() kind!: string;
  @Field(() => String, { nullable: true }) ref!: string | null;
  @Field() createdAt!: string;
  @Field() read!: boolean;
}

export interface CallRow {
  call_id: string;
  account_id: string;
  method: string;
  args_b64: string;
  status: string;
}

export function callView(c: CallRow): AccountCall {
  const args = JSON.parse(Buffer.from(c.args_b64, 'base64').toString()) as { new_limit?: string; token?: string };
  return { callId: c.call_id, accountId: c.account_id, methodName: c.method, argsBase64: c.args_b64, status: c.status, newLimit: args.new_limit ?? null, token: args.token ?? null, effectiveAt: null };
}

@Resolver()
export class SigningResolver {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly chain: NearChain,
    private readonly guardian: GuardianClient,
    private readonly identity: IdTokenVerifier,
    private readonly audit: AuditService,
  ) {}

  @Mutation(() => UnsignedDelegateView)
  @RateLimit('quote')
  async buildDelegate(@Context('req') req: ObibaRequest, @Args('input') input: BuildDelegateInput): Promise<UnsignedDelegateView> {
    const { uid } = identityOf(req);
    const targets = [input.opId, input.callId, input.cancelRecovery ? 'x' : null].filter((v) => v != null);
    if (targets.length !== 1) throw appError('BAD_INPUT', 'target');
    try {
      ed25519KeyBytes(input.publicKey);
    } catch {
      throw appError('BAD_INPUT', 'publicKey');
    }
    const target = await withUserTx(this.pool, uid, async (c) => {
      const device = await c.query("select 1 from identity.devices where uid = $1 and public_key = $2 and status = 'active'", [uid, input.publicKey]);
      if (!device.rowCount) throw appError('FORBIDDEN', 'publicKey');
      if (input.opId != null) {
        if (!isHexId(input.opId)) throw appError('BAD_INPUT', 'opId');
        const r = await c.query<{ account_id: string; status: string; canonical: { method: string; args_b64: string } }>(
          'select account_id, status, canonical from ops.prepared_ops where op_id = $1',
          [input.opId],
        );
        const op = r.rows[0];
        if (!op) throw appError('NOT_FOUND', 'opId');
        if (op.status !== 'PREPARED' && op.status !== 'COSIGNED') throw appError('CONFLICT', 'opId');
        return { account: op.account_id, method: op.canonical.method, args: Buffer.from(op.canonical.args_b64, 'base64') };
      }
      if (input.callId != null) {
        if (!isHexId(input.callId)) throw appError('BAD_INPUT', 'callId');
        const r = await c.query<CallRow>("select call_id, account_id, method, args_b64, status from ops.account_calls where call_id = $1 and status = 'PREPARED'", [input.callId]);
        if (!r.rows[0]) throw appError('NOT_FOUND', 'callId');
        return { account: r.rows[0].account_id, method: r.rows[0].method, args: Buffer.from(r.rows[0].args_b64, 'base64') };
      }
      const a = await c.query<{ account_id: string }>('select account_id from chain.accounts where uid = $1', [uid]);
      if (!a.rows[0]) throw appError('FORBIDDEN');
      return { account: a.rows[0].account_id, method: 'cancel_recovery', args: CANCEL_ARGS };
    });
    let height: bigint;
    let nonce: bigint | null;
    try {
      [height, nonce] = await Promise.all([this.chain.finalBlockHeight(), this.chain.accessKeyNonce(target.account, input.publicKey)]);
    } catch {
      throw appError('SERVICE_PAUSED');
    }
    if (nonce === null) throw appError('FORBIDDEN', 'publicKey');
    const unsigned = buildUnsignedDelegate({
      account: target.account,
      methodName: target.method,
      args: target.args,
      gas: GAS[target.method]!,
      nonce: nonce + 1n,
      maxBlockHeight: height + DELEGATE_TTL_BLOCKS,
      publicKey: input.publicKey,
    });
    return {
      accountId: target.account,
      methodName: target.method,
      delegateBase64: unsigned.delegateBase64,
      signingHashHex: unsigned.signingHashHex,
      nonce: unsigned.nonce.toString(),
      maxBlockHeight: unsigned.maxBlockHeight.toString(),
    };
  }

  @Query(() => String)
  assembleSignedDelegate(@Args('delegateBase64') delegateBase64: string, @Args('signatureBase64') signatureBase64: string): string {
    if (delegateBase64.length > 12_000 || !/^[A-Za-z0-9+/]{86}==$/.test(signatureBase64)) throw appError('BAD_INPUT', 'signatureBase64');
    try {
      return assembleSignedDelegate(delegateBase64, signatureBase64);
    } catch {
      throw appError('BAD_INPUT', 'delegateBase64');
    }
  }

  @Query(() => [String])
  @RateLimit('quote')
  async tokensToEnable(@Context('req') req: ObibaRequest): Promise<string[]> {
    const { uid } = identityOf(req);
    const accountId = await withUserTx(this.pool, uid, (c) => activeAccount(c, uid));
    return tokensToEnable(this.chain, this.config, accountId);
  }

  @Mutation(() => AccountCall)
  @RateLimit('quote')
  async prepareTokenEnable(@Context('req') req: ObibaRequest, @Args('token') token: string): Promise<AccountCall> {
    const { uid } = identityOf(req);
    if (!usdcContracts(this.config).includes(token)) throw appError('BAD_INPUT', 'token');
    const seed = this.config.GUARDIAN_LOCAL_SEED_HEX;
    if (!seed || this.config.NODE_ENV === 'production' || this.config.NEAR_NETWORK === 'mainnet') throw appError('SERVICE_PAUSED');
    const accountId = await withUserTx(this.pool, uid, (c) => activeAccount(c, uid));
    let policy;
    try {
      policy = await this.chain.policy(accountId);
    } catch {
      throw appError('SERVICE_PAUSED');
    }
    if ((policy.tokens ?? []).some((t) => t.token === token && t.enabled)) throw appError('CONFLICT', 'token');
    if (!policy.guardian || policy.guardian_nonce === undefined) throw appError('SERVICE_PAUSED');
    const guardianNonce = String(policy.guardian_nonce);
    const digest = sha256(guardianPreimage(this.config.NEAR_NETWORK, accountId, { purpose: 'AddToken', payload: { token, decimals: USDC_DECIMALS, guardian_nonce: guardianNonce } }));
    const signature = localGuardianSign(seed, digest);
    if (!verifyEd25519(policy.guardian, digest, signature)) throw appError('SERVICE_PAUSED');
    const call = await this.storeCall(uid, accountId, { token, decimals: USDC_DECIMALS, guardian_sig: signature.toString('base64'), guardian_nonce: guardianNonce });
    await this.audit.record({ actor: uid, action: 'token.enable', target: call.callId, outcome: 'ALLOWED', requestId: req.requestId, details: { token } });
    return call;
  }

  private async storeCall(uid: string, accountId: string, args: Record<string, unknown>): Promise<AccountCall> {
    return withUserTx(this.pool, uid, async (c) => {
      const r = await c.query<CallRow>(
        "insert into ops.account_calls(call_id, uid, account_id, method, args_b64, status) values ($1, $2, $3, $4, $5, 'PREPARED') returning call_id, account_id, method, args_b64, status",
        [newHexId(), uid, accountId, 'add_token', Buffer.from(JSON.stringify(args)).toString('base64')],
      );
      return callView(r.rows[0]!);
    });
  }

  @Mutation(() => AccountCall)
  @RateLimit('money', 'money_daily')
  async submitAccountCall(@Context('req') req: ObibaRequest, @Args('callId') callId: string, @Args('signedDelegate') signedDelegate: string): Promise<AccountCall> {
    const { uid } = identityOf(req);
    if (!isHexId(callId)) throw appError('BAD_INPUT', 'callId');
    if (typeof signedDelegate !== 'string' || signedDelegate.length > 12_000) throw appError('BAD_INPUT', 'signedDelegate');
    let height: bigint;
    try {
      height = await this.chain.finalBlockHeight();
    } catch {
      throw appError('SERVICE_PAUSED');
    }
    return withUserTx(this.pool, uid, async (c) => {
      const r = await c.query<CallRow>('select call_id, account_id, method, args_b64, status from ops.account_calls where call_id = $1 for update', [callId]);
      const call = r.rows[0];
      if (!call) throw appError('NOT_FOUND', 'callId');
      if (call.status !== 'PREPARED') throw appError('CONFLICT', 'callId');
      const devices = await c.query<{ public_key: string }>("select public_key from identity.devices where uid = $1 and status = 'active'", [uid]);
      const check = checkSignedDelegate(signedDelegate, {
        account: call.account_id,
        methodName: call.method,
        args: Buffer.from(call.args_b64, 'base64'),
        devicePublicKeys: devices.rows.map((d) => d.public_key),
        maxGas: MAX_GAS[call.method] ?? 0n,
        currentBlockHeight: height,
        maxBlockHeightWindow: MAX_BLOCK_WINDOW,
      });
      if (!check.ok) {
        await this.audit.record({ actor: uid, action: 'call.submit', target: callId, outcome: 'DENIED', requestId: req.requestId, details: { reason: check.reason } }, c);
        throw appError('SIGNED_OP_MISMATCH');
      }
      const u = await c.query<CallRow>(
        "update ops.account_calls set status = 'SUBMITTED', signed_delegate = $2, updated_at = now() where call_id = $1 returning call_id, account_id, method, args_b64, status",
        [callId, signedDelegate],
      );
      await c.query("insert into infra.outbox(topic, payload) values ('account.call', $1)", [JSON.stringify({ call_id: callId })]);
      await this.audit.record({ actor: uid, action: 'call.submit', target: callId, outcome: 'ALLOWED', requestId: req.requestId }, c);
      return callView(u.rows[0]!);
    });
  }

  @Query(() => AccountCall, { nullable: true })
  async accountCall(@Context('req') req: ObibaRequest, @Args('callId') callId: string): Promise<AccountCall | null> {
    const { uid } = identityOf(req);
    if (!isHexId(callId)) throw appError('BAD_INPUT', 'callId');
    const r = await withUserTx(this.pool, uid, (c) => c.query<CallRow>('select call_id, account_id, method, args_b64, status from ops.account_calls where call_id = $1', [callId]));
    return r.rows[0] ? callView(r.rows[0]) : null;
  }

  @Query(() => [DeviceView])
  async devices(@Context('req') req: ObibaRequest): Promise<DeviceView[]> {
    const { uid } = identityOf(req);
    const r = await withUserTx(this.pool, uid, (c) =>
      c.query<{ public_key: string; status: string; initial: boolean; created_at: Date; kind: string; label: string | null }>(
        'select public_key, status, initial, created_at, kind, label from identity.devices order by created_at',
      ),
    );
    return r.rows.map((d) => ({ publicKey: d.public_key, status: d.status, initial: d.initial, createdAt: new Date(d.created_at).toISOString(), kind: d.kind, label: d.label }));
  }

  @Query(() => AccountView)
  async account(@Context('req') req: ObibaRequest): Promise<AccountView> {
    const { uid } = identityOf(req);
    const r = await withUserTx(this.pool, uid, (c) => c.query<{ account_id: string; status: string }>('select account_id, status from chain.accounts where uid = $1', [uid]));
    const a = r.rows[0];
    return {
      accountId: a?.account_id ?? null,
      status: a?.status ?? null,
      explorerUrl: a ? explorerAccountUrl(this.config, a.account_id) : null,
      network: this.config.NEAR_NETWORK,
      usdcContract: this.config.USDC_CONTRACT,
    };
  }

  @Mutation(() => Boolean)
  @RequireFreshSession()
  @RateLimit('profile')
  async signOutEverywhere(@Context('req') req: ObibaRequest): Promise<boolean> {
    const { uid } = identityOf(req);
    try {
      await this.identity.revokeSessions(uid);
    } catch {
      throw appError('SERVICE_PAUSED');
    }
    await this.audit.record({ actor: uid, action: 'session.revoke_all', outcome: 'ALLOWED', requestId: req.requestId });
    return true;
  }

  @Query(() => [NotificationView])
  async notifications(@Context('req') req: ObibaRequest, @Args('first', { type: () => Int, defaultValue: 20 }) first: number): Promise<NotificationView[]> {
    const { uid } = identityOf(req);
    if (!Number.isInteger(first) || first < 1 || first > 100) throw appError('BAD_INPUT', 'first');
    const r = await withUserTx(this.pool, uid, (c) =>
      c.query<{ id: string; kind: string; ref: string | null; created_at: Date; read_at: Date | null }>('select id, kind, ref, created_at, read_at from ops.notifications order by id desc limit $1', [first]),
    );
    return r.rows.map((n) => ({ id: String(n.id), kind: n.kind, ref: n.ref, createdAt: new Date(n.created_at).toISOString(), read: n.read_at !== null }));
  }

  @Mutation(() => Int)
  async markNotificationsRead(@Context('req') req: ObibaRequest, @Args('upToId') upToId: string): Promise<number> {
    const { uid } = identityOf(req);
    if (!/^[1-9]\d{0,17}$/.test(upToId)) throw appError('BAD_INPUT', 'upToId');
    const r = await withUserTx(this.pool, uid, (c) => c.query('update ops.notifications set read_at = now() where id <= $1 and read_at is null', [upToId]));
    return r.rowCount ?? 0;
  }
}
