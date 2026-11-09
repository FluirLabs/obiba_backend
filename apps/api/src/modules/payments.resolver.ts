import { Inject } from '@nestjs/common';
import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import type { Pool, PoolClient } from 'pg';
import { withUserTx } from '@obiba/db';
import { deviceOpPreimage, emailJob, enqueueEmail, newHexId, originLabel, sha256, USDC_DECIMALS, type Op } from '@obiba/domain';
import { checkSignedDelegate } from '@obiba/near';
import { APP_CONFIG, type AppConfig } from '../config';
import { appError } from '../errors';
import { PreparedOp, PrepareTransferInput, SubmitResult } from '../graphql/types';
import { AuditService } from '../infra/audit';
import { NearChain } from '../infra/near-chain';
import { PG_POOL, REDIS } from '../infra/tokens';
import type Redis from 'ioredis';
import { switchedOff } from '../security/kill-switch';
import { RateLimit, RequireStepUp } from '../security/decorators';
import { GuardianClient } from '../infra/guardian-client';
import { IdempotencyService } from '../security/idempotency';
import { KillSwitch } from '../security/kill-switch';
import { identityOf, type ObibaRequest } from '../security/request';
import { classifyRecipient, resolveRecipient } from './recipients';
import { spendToken, usdcContracts } from './tokens';
import { amount } from './validation';

const OP_TTL_NS = 10n * 60n * 1_000_000_000n;
const HOLD_TTL = '1 hour';
const MAX_BLOCK_WINDOW = 600n;
const MAX_GAS: Record<string, bigint> = { execute: 60_000_000_000_000n, pay_invoice: 200_000_000_000_000n };

export function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

interface Canonical {
  method: 'execute' | 'pay_invoice';
  args_b64: string;
  op: Op;
}

export async function activeAccount(c: PoolClient, uid: string): Promise<string> {
  const r = await c.query<{ account_id: string; status: string }>('select account_id, status from chain.accounts where uid = $1', [uid]);
  const a = r.rows[0];
  if (!a || a.status !== 'active') throw appError('FORBIDDEN');
  return a.account_id;
}

export async function storePreparedOp(
  c: PoolClient,
  config: AppConfig,
  uid: string,
  accountId: string,
  op: Op,
  method: Canonical['method'],
  args: Record<string, unknown>,
  invoiceId: string | null,
): Promise<PreparedOp> {
  const argsBytes = Buffer.from(JSON.stringify(args));
  const canonical: Canonical = { method, args_b64: argsBytes.toString('base64'), op };
  await c.query(
    `insert into ops.prepared_ops(op_id, uid, account_id, kind, receiver, amount, expires_at_ns, canonical, needs_guardian, status, invoice_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, false, 'PREPARED', $9)`,
    [op.op_id, uid, accountId, op.kind, op.receiver, op.amount, op.expires_at_ns, JSON.stringify(canonical), invoiceId],
  );
  return {
    opId: op.op_id,
    accountId,
    methodName: method,
    argsBase64: canonical.args_b64,
    deviceOpHash: sha256(deviceOpPreimage(config.NEAR_NETWORK, accountId, op)).toString('hex'),
    receiver: op.receiver,
    amount: op.amount,
    expiresAtNs: op.expires_at_ns,
  };
}

@Resolver()
export class PaymentsResolver {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly chain: NearChain,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly guardian: GuardianClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Mutation(() => PreparedOp)
  @RequireStepUp()
  @RateLimit('money')
  @KillSwitch('transfers')
  async requestCosign(
    @Context('req') req: ObibaRequest,
    @Args('opId') opId: string,
    @Args('deviceSignature') deviceSignature: string,
  ): Promise<PreparedOp> {
    const { uid } = identityOf(req);
    if (!/^[0-9a-f]{32}$/.test(opId)) throw appError('BAD_INPUT', 'opId');
    if (!/^[A-Za-z0-9+/]{86}==$/.test(deviceSignature)) throw appError('BAD_INPUT', 'deviceSignature');
    const idToken = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!idToken) throw appError('UNAUTHENTICATED');
    const owned = await withUserTx(this.pool, uid, (c) => c.query("select 1 from ops.prepared_ops where op_id = $1 and status = 'PREPARED'", [opId]));
    if (!owned.rowCount) throw appError('NOT_FOUND', 'opId');
    let result;
    try {
      result = await this.guardian.cosign(opId, deviceSignature, idToken);
    } catch {
      throw appError('SERVICE_PAUSED');
    }
    if (!result.ok) {
      await this.audit.record({ actor: uid, action: 'op.cosign', target: opId, outcome: 'DENIED', requestId: req.requestId, details: { reason: result.reason.slice(0, 200) } });
      throw appError('FORBIDDEN');
    }
    const signature = result.signature;
    return withUserTx(this.pool, uid, async (c) => {
      const r = await c.query<{ account_id: string; canonical: Canonical }>(
        "select account_id, canonical from ops.prepared_ops where op_id = $1 and status = 'PREPARED' for update",
        [opId],
      );
      const row = r.rows[0];
      if (!row) throw appError('CONFLICT', 'opId');
      const args = JSON.parse(Buffer.from(row.canonical.args_b64, 'base64').toString()) as Record<string, unknown>;
      args.guardian_sig = signature;
      const canonical: Canonical = { ...row.canonical, args_b64: Buffer.from(JSON.stringify(args)).toString('base64') };
      await c.query("update ops.prepared_ops set guardian_sig = $2, canonical = $3, status = 'COSIGNED', updated_at = now() where op_id = $1", [
        opId,
        signature,
        JSON.stringify(canonical),
      ]);
      await this.audit.record({ actor: uid, action: 'op.cosign', target: opId, outcome: 'ALLOWED', requestId: req.requestId }, c);
      const op = row.canonical.op;
      return {
        opId,
        accountId: row.account_id,
        methodName: canonical.method,
        argsBase64: canonical.args_b64,
        deviceOpHash: sha256(deviceOpPreimage(this.config.NEAR_NETWORK, row.account_id, op)).toString('hex'),
        receiver: op.receiver,
        amount: op.amount,
        expiresAtNs: op.expires_at_ns,
      };
    });
  }

  @Mutation(() => PreparedOp)
  @RateLimit('quote')
  @KillSwitch('transfers')
  async prepareTransfer(@Context('req') req: ObibaRequest, @Args('input') input: PrepareTransferInput): Promise<PreparedOp> {
    const { uid } = identityOf(req);
    const given = [input.toHandle, input.toPhone, input.toAccount].filter((v) => v != null);
    if (given.length !== 1) throw appError('BAD_INPUT', 'recipient');
    const field = input.toHandle != null ? 'toHandle' : input.toPhone != null ? 'toPhone' : 'toAccount';
    const query = classifyRecipient(field === 'toHandle' ? `@${String(input.toHandle).replace(/^@/, '')}` : String(given[0]));
    if ((field === 'toHandle' && query.by !== 'handle') || (field === 'toPhone' && query.by !== 'phone') || (field === 'toAccount' && query.by !== 'account')) {
      throw appError('BAD_INPUT', field);
    }
    const units = amount(input.amount, USDC_DECIMALS, this.config.MAX_OP_AMOUNT);
    return withUserTx(this.pool, uid, async (c) => {
      const accountId = await activeAccount(c, uid);
      const found = await resolveRecipient(c, this.chain, this.config, query);
      if (!found) throw appError(query.by === 'account' ? 'BAD_INPUT' : 'NOT_FOUND', field);
      const receiver = found.accountId;
      if (receiver === accountId || usdcContracts(this.config).includes(receiver)) throw appError('BAD_INPUT', 'recipient');
      if (!found.canReceive) throw appError('RECIPIENT_NOT_REGISTERED', field);
      const token = await spendToken(this.chain, this.config, accountId, units);
      if (token !== this.config.USDC_CONTRACT) {
        let registered: boolean;
        try {
          registered = await this.chain.storageRegistered(token, receiver);
        } catch {
          throw appError('SERVICE_PAUSED');
        }
        if (!registered) throw appError('RECIPIENT_NOT_REGISTERED', field);
      }
      const op: Op = {
        op_id: newHexId(),
        kind: 'Transfer',
        token,
        receiver,
        amount: units.toString(),
        expires_at_ns: (nowNs() + OP_TTL_NS).toString(),
        memo: null,
      };
      return storePreparedOp(c, this.config, uid, accountId, op, 'execute', { op, guardian_sig: null }, null);
    });
  }

  @Mutation(() => SubmitResult)
  @RateLimit('money', 'money_daily')
  @KillSwitch('transfers')
  async submitSignedOp(
    @Context('req') req: ObibaRequest,
    @Args('opId') opId: string,
    @Args('signedDelegate') signedDelegate: string,
    @Args('idempotencyKey') idempotencyKey: string,
  ): Promise<SubmitResult> {
    const { uid } = identityOf(req);
    if (!/^[0-9a-f]{32}$/.test(opId)) throw appError('BAD_INPUT', 'opId');
    if (typeof signedDelegate !== 'string' || signedDelegate.length > 12_000) throw appError('BAD_INPUT', 'signedDelegate');
    return this.idempotency.run(uid, idempotencyKey, { opId, signedDelegate }, async () => {
      const withdrawal = await withUserTx(this.pool, uid, (c) => c.query('select 1 from ops.withdrawals where op_id = $1', [opId]));
      if (withdrawal.rowCount && (await switchedOff(this.redis, ['withdrawals']))) throw appError('SERVICE_PAUSED');
      let height: bigint;
      try {
        height = await this.chain.finalBlockHeight();
      } catch {
        throw appError('SERVICE_PAUSED');
      }
      let denial: string | null = null;
      try {
        return await withUserTx(this.pool, uid, async (c) => {
          const r = await c.query<{ account_id: string; amount: string; expires_at_ns: string; status: string; canonical: Canonical; invoice_id: string | null }>(
            'select account_id, amount::text, expires_at_ns::text, status, canonical, invoice_id from ops.prepared_ops where op_id = $1 for update',
            [opId],
          );
          const op = r.rows[0];
          if (!op) throw appError('NOT_FOUND', 'opId');
          if (op.status !== 'PREPARED' && op.status !== 'COSIGNED') throw appError('CONFLICT', 'opId');
          if (BigInt(op.expires_at_ns) <= nowNs()) throw appError('EXPIRED');
          const devices = await c.query<{ public_key: string }>("select public_key from identity.devices where uid = $1 and status = 'active'", [uid]);
          const check = checkSignedDelegate(signedDelegate, {
            account: op.account_id,
            methodName: op.canonical.method,
            args: Buffer.from(op.canonical.args_b64, 'base64'),
            devicePublicKeys: devices.rows.map((d) => d.public_key),
            maxGas: MAX_GAS[op.canonical.method] ?? 0n,
            currentBlockHeight: height,
            maxBlockHeightWindow: MAX_BLOCK_WINDOW,
          });
          if (!check.ok) {
            denial = check.reason;
            throw appError('SIGNED_OP_MISMATCH');
          }
          if (op.invoice_id) {
            const reserved = await c.query<{ ok: boolean }>('select ops.reserve_invoice($1) as ok', [op.invoice_id]);
            if (!reserved.rows[0]?.ok) throw appError('CONFLICT', 'invoiceId');
          }
          const wallet = await c.query<{ id: string }>(
            "select ledger.ensure_account('REAL', 'WALLET', $1, 'USDC') as id",
            [`wallet:${op.account_id}`],
          );
          try {
            await c.query('select ledger.place_hold($1, $2, $3, now() + $4::interval)', [`op:${opId}`, wallet.rows[0]!.id, op.amount, HOLD_TTL]);
          } catch (err) {
            if ((err as { code?: string }).code === '23514') throw appError('INSUFFICIENT_FUNDS');
            throw err;
          }
          await c.query("update ops.prepared_ops set status = 'SUBMITTED', signed_delegate = $2, updated_at = now() where op_id = $1", [opId, signedDelegate]);
          await c.query("insert into infra.outbox(topic, payload) values ('relay.submit', $1)", [JSON.stringify({ op_id: opId })]);
          const requested = await c.query<{ id: string; destination: string; recipient: string; amount_in: string; amount_out_formatted: string | null }>(
            "select id, destination, recipient, amount_in::text, quote->'quote'->>'amountOutFormatted' as amount_out_formatted from ops.withdrawals where op_id = $1",
            [opId],
          );
          const w = requested.rows[0];
          if (w) {
            await enqueueEmail(
              c,
              emailJob('WITHDRAWAL_REQUESTED', { uid }, `withdrawal:${w.id}:REQUESTED`, {
                withdrawalId: w.id,
                units: w.amount_in,
                decimals: USDC_DECIMALS,
                currency: 'USDC',
                destination: originLabel(w.destination),
                recipient: w.recipient,
                received: w.amount_out_formatted && /^\d{1,30}(\.\d{1,24})?$/.test(w.amount_out_formatted) ? w.amount_out_formatted : null,
                at: new Date().toISOString(),
              }),
            );
          }
          await this.audit.record(
            { actor: uid, action: 'op.submit', target: opId, outcome: 'ALLOWED', requestId: req.requestId, details: { delegate_hash: check.delegateHash } },
            c,
          );
          return { opId, status: 'SUBMITTED', delegateHash: check.delegateHash };
        });
      } catch (err) {
        if (denial) {
          await this.audit.record({ actor: uid, action: 'op.submit', target: opId, outcome: 'DENIED', requestId: req.requestId, details: { reason: denial } });
        }
        throw err;
      }
    });
  }
}
