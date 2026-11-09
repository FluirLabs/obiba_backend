import { Inject } from '@nestjs/common';
import { Args, Context, Field, ID, InputType, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import type { Pool } from 'pg';
import { withUserTx } from '@obiba/db';
import { emailJob, enqueueEmail, isHexId } from '@obiba/domain';
import { MAINNET_ORIGINS, OneClickClient, OneClickError, checkSignedQuote, validRefundAddress, type OriginAsset, type QuoteRequest } from '@obiba/intents';
import { APP_CONFIG, explorerTxUrl, type AppConfig } from '../config';
import { appError } from '../errors';
import { AuditService } from '../infra/audit';
import { PG_POOL } from '../infra/tokens';
import { RateLimit } from '../security/decorators';
import { KillSwitch } from '../security/kill-switch';
import { identityOf, type ObibaRequest } from '../security/request';
import { activeAccount } from './payments.resolver';
import { amount } from './validation';
import { recoverySetUp } from '../infra/notify';
import { IdTokenVerifier } from '../security/identity';
import { QuoteFees, QuoteView, feesOf, quoteView } from './quotes';

export const ONECLICK = Symbol('ONECLICK');
const DEADLINE_MS = 60 * 60 * 1000;
const MAX_UNITS = 100_000n;

@ObjectType()
export class DepositOption {
  @Field() key!: string;
  @Field() label!: string;
  @Field(() => Int) decimals!: number;
  @Field(() => Int) minUsd!: number;
}

@InputType()
export class StartDepositInput {
  @Field() origin!: string;
  @Field() amount!: string;
  @Field() refundAddress!: string;
}

@ObjectType()
export class DepositInstructions {
  @Field(() => ID) depositId!: string;
  @Field() origin!: string;
  @Field() depositAddress!: string;
  @Field(() => String, { nullable: true }) depositMemo!: string | null;
  @Field() amountIn!: string;
  @Field() minAmountIn!: string;
  @Field() minAmountOut!: string;
  @Field() deadline!: string;
  @Field(() => Int, { nullable: true }) timeEstimateSeconds!: number | null;
  @Field() status!: string;
  @Field(() => [String]) originTxHashes!: string[];
  @Field(() => [String]) nearTxHashes!: string[];
  @Field(() => [String]) nearExplorerUrls!: string[];
  @Field(() => String, { nullable: true }) createdAt!: string | null;
  @Field(() => QuoteFees) fees!: QuoteFees;
}

@ObjectType()
export class DirectDeposit {
  @Field() network!: string;
  @Field() token!: string;
  @Field() tokenContract!: string;
  @Field() address!: string;
}

interface DepositRow {
  id: string;
  origin_asset: string;
  deposit_address: string;
  deposit_memo: string | null;
  amount_in: string;
  min_amount_out: string;
  quote: { quote?: Record<string, unknown> };
  status: string;
  tx_hashes: { origin?: unknown; near?: unknown };
  created_at: Date;
}

const DEPOSIT_COLUMNS = 'id, origin_asset, deposit_address, deposit_memo, amount_in, min_amount_out::text, quote, status, tx_hashes, created_at';

function hashes(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string' && /^[0-9A-Za-z]{32,90}$/.test(h)).slice(0, 10) : [];
}

export function toDepositView(d: DepositRow, config: AppConfig): DepositInstructions {
  const near = hashes(d.tx_hashes?.near);
  return {
    depositId: d.id,
    origin: d.origin_asset,
    depositAddress: d.deposit_address,
    depositMemo: d.deposit_memo,
    amountIn: d.amount_in,
    minAmountIn: String(d.quote?.quote?.minAmountIn ?? d.amount_in),
    minAmountOut: d.min_amount_out,
    deadline: String(d.quote?.quote?.deadline ?? ''),
    timeEstimateSeconds: typeof d.quote?.quote?.timeEstimate === 'number' ? d.quote.quote.timeEstimate : null,
    status: d.status,
    originTxHashes: hashes(d.tx_hashes?.origin),
    nearTxHashes: near,
    nearExplorerUrls: near.map((h) => explorerTxUrl(config, h)).filter((u): u is string => u !== null),
    createdAt: d.created_at ? new Date(d.created_at).toISOString() : null,
    fees: feesOf(d.quote?.quote, config.ONECLICK_APP_FEE_BPS),
  };
}

export function depositOrigins(config: AppConfig): OriginAsset[] {
  if (config.DEPOSIT_ORIGINS) return JSON.parse(config.DEPOSIT_ORIGINS) as OriginAsset[];
  return config.NEAR_NETWORK === 'mainnet' ? MAINNET_ORIGINS : [];
}

@Resolver()
export class DepositsResolver {
  private readonly origins: Map<string, OriginAsset>;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ONECLICK) private readonly oneclick: OneClickClient,
    private readonly audit: AuditService,
    private readonly verifier: IdTokenVerifier,
  ) {
    this.origins = new Map(depositOrigins(config).map((o) => [o.key, o]));
  }

  @Query(() => [DepositOption])
  depositOptions(): DepositOption[] {
    return [...this.origins.values()].map(({ key, label, decimals, minUsd }) => ({ key, label, decimals, minUsd }));
  }

  private async quoteBody(uid: string, input: StartDepositInput, dry: boolean): Promise<{ body: QuoteRequest; origin: OriginAsset; units: bigint; accountId: string }> {
    const origin = this.origins.get(input.origin);
    if (!origin) throw appError('BAD_INPUT', 'origin');
    if (!validRefundAddress(origin.chain, input.refundAddress)) throw appError('BAD_INPUT', 'refundAddress');
    const units = amount(input.amount, origin.decimals, MAX_UNITS * 10n ** BigInt(origin.decimals));
    const accountId = await withUserTx(this.pool, uid, async (c) => {
      const account = await activeAccount(c, uid);
      if (!(await recoverySetUp(c, uid, this.verifier))) throw appError('RECOVERY_SETUP_REQUIRED');
      return account;
    });
    const body: QuoteRequest = {
      dry,
      swapType: 'FLEX_INPUT',
      slippageTolerance: 100,
      originAsset: origin.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: `nep141:${this.config.USDC_CONTRACT}`,
      amount: units.toString(),
      refundTo: input.refundAddress,
      refundType: 'ORIGIN_CHAIN',
      recipient: accountId,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + DEADLINE_MS).toISOString(),
      ...(this.config.ONECLICK_APP_FEE_BPS > 0 ? { appFees: [{ recipient: this.config.ONECLICK_FEE_RECIPIENT!, fee: this.config.ONECLICK_APP_FEE_BPS }] } : {}),
    };
    return { body, origin, units, accountId };
  }

  private async fetchQuote(body: QuoteRequest) {
    try {
      return await this.oneclick.quote(body);
    } catch (err) {
      if (err instanceof OneClickError) {
        if (err.code === 'ONECLICK_UNAVAILABLE') throw appError('SERVICE_PAUSED');
        throw appError('BAD_INPUT', err.code === 'RECIPIENT_INVALID' ? 'refundAddress' : 'amount');
      }
      throw appError('SERVICE_PAUSED');
    }
  }

  @Query(() => DirectDeposit)
  async directDeposit(@Context('req') req: ObibaRequest): Promise<DirectDeposit> {
    const { uid } = identityOf(req);
    const accountId = await withUserTx(this.pool, uid, async (c) => {
      const account = await activeAccount(c, uid);
      if (!(await recoverySetUp(c, uid, this.verifier))) throw appError('RECOVERY_SETUP_REQUIRED');
      return account;
    });
    return { network: 'NEAR', token: 'USDC', tokenContract: this.config.USDC_CONTRACT, address: accountId };
  }

  @Mutation(() => QuoteView)
  @RateLimit('quote')
  @KillSwitch('deposits')
  async quoteDeposit(@Context('req') req: ObibaRequest, @Args('input') input: StartDepositInput): Promise<QuoteView> {
    const { uid } = identityOf(req);
    const { body, origin, units } = await this.quoteBody(uid, input, true);
    const res = await this.fetchQuote(body);
    const check = checkSignedQuote(res, body, origin, this.config.ONECLICK_QUOTE_PUBLIC_KEY, { dry: true });
    if (!check.ok) {
      await this.audit.record({ actor: uid, action: 'deposit.quote', outcome: 'DENIED', requestId: req.requestId, details: { reason: check.reason, dry: true } });
      throw appError('SERVICE_PAUSED');
    }
    return quoteView(origin.key, res.quote, units.toString(), this.config.ONECLICK_APP_FEE_BPS);
  }

  @Mutation(() => DepositInstructions)
  @RateLimit('quote')
  @KillSwitch('deposits')
  async startDeposit(@Context('req') req: ObibaRequest, @Args('input') input: StartDepositInput): Promise<DepositInstructions> {
    const { uid } = identityOf(req);
    const { body, origin, units, accountId } = await this.quoteBody(uid, input, false);
    const res = await this.fetchQuote(body);
    const check = checkSignedQuote(res, body, origin, this.config.ONECLICK_QUOTE_PUBLIC_KEY);
    if (!check.ok) {
      await this.audit.record({ actor: uid, action: 'deposit.quote', outcome: 'DENIED', requestId: req.requestId, details: { reason: check.reason } });
      throw appError('SERVICE_PAUSED');
    }
    const q = res.quote;
    const minOut = String(q.minAmountOut ?? '');
    if (!/^[1-9]\d{0,38}$/.test(minOut)) throw appError('SERVICE_PAUSED');
    const memo = q.depositMemo ? String(q.depositMemo) : null;
    try {
      return await withUserTx(this.pool, uid, async (c) => {
        const r = await c.query<{ id: string }>(
          `insert into ops.deposits(uid, account_id, origin_asset, deposit_address, deposit_memo, amount_in, min_amount_out, correlation_id, quote, status)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'AWAITING_DEPOSIT') returning id`,
          [uid, accountId, origin.key, String(q.depositAddress), memo, String(q.amountIn ?? units), minOut, res.correlationId ?? null, JSON.stringify(res)],
        );
        await this.audit.record({ actor: uid, action: 'deposit.start', target: r.rows[0]!.id, outcome: 'ALLOWED', requestId: req.requestId }, c);
        await enqueueEmail(
          c,
          emailJob('DEPOSIT_INITIATED', { uid }, `deposit:${r.rows[0]!.id}:INITIATED`, {
            depositId: r.rows[0]!.id,
            origin: origin.label,
            amount: typeof q.amountInFormatted === 'string' && /^\d{1,30}(\.\d{1,24})?$/.test(q.amountInFormatted) ? q.amountInFormatted : null,
            at: new Date().toISOString(),
          }),
        );
        return {
          depositId: r.rows[0]!.id,
          origin: origin.key,
          depositAddress: String(q.depositAddress),
          depositMemo: memo,
          amountIn: String(q.amountIn ?? units),
          minAmountIn: String(q.minAmountIn ?? units),
          minAmountOut: minOut,
          deadline: String(q.deadline ?? body.deadline),
          timeEstimateSeconds: typeof q.timeEstimate === 'number' ? q.timeEstimate : null,
          status: 'AWAITING_DEPOSIT',
          originTxHashes: [],
          nearTxHashes: [],
          nearExplorerUrls: [],
          createdAt: new Date().toISOString(),
          fees: feesOf(q, this.config.ONECLICK_APP_FEE_BPS),
        };
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw appError('CONFLICT');
      throw err;
    }
  }

  @Query(() => DepositInstructions, { nullable: true })
  async deposit(@Context('req') req: ObibaRequest, @Args('id') id: string): Promise<DepositInstructions | null> {
    const { uid } = identityOf(req);
    if (!/^[0-9a-f-]{36}$/.test(id) && !isHexId(id)) throw appError('BAD_INPUT', 'id');
    const r = await withUserTx(this.pool, uid, (c) => c.query<DepositRow>(`select ${DEPOSIT_COLUMNS} from ops.deposits where id = $1`, [id]));
    return r.rows[0] ? toDepositView(r.rows[0], this.config) : null;
  }

  @Query(() => [DepositInstructions])
  async deposits(@Context('req') req: ObibaRequest, @Args('first', { type: () => Int, defaultValue: 20 }) first: number): Promise<DepositInstructions[]> {
    const { uid } = identityOf(req);
    if (!Number.isInteger(first) || first < 1 || first > 50) throw appError('BAD_INPUT', 'first');
    const r = await withUserTx(this.pool, uid, (c) => c.query<DepositRow>(`select ${DEPOSIT_COLUMNS} from ops.deposits order by created_at desc limit $1`, [first]));
    return r.rows.map((d) => toDepositView(d, this.config));
  }
}
