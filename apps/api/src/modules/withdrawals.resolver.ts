import { Inject } from '@nestjs/common';
import { Args, Context, Field, ID, InputType, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import type { Pool } from 'pg';
import { withUserTx } from '@obiba/db';
import { isNearAccountId, newHexId, USDC_DECIMALS, type Op } from '@obiba/domain';
import {
  MAINNET_DESTINATIONS,
  OneClickClient,
  OneClickError,
  checkSignedQuote,
  parseDestinations,
  validRefundAddress,
  type DestinationAsset,
  type QuoteRequest,
} from '@obiba/intents';
import { APP_CONFIG, type AppConfig } from '../config';
import { appError } from '../errors';
import { PreparedOp } from '../graphql/types';
import { AuditService } from '../infra/audit';
import { NearChain } from '../infra/near-chain';
import { PG_POOL } from '../infra/tokens';
import { RateLimit } from '../security/decorators';
import { KillSwitch } from '../security/kill-switch';
import { identityOf, type ObibaRequest } from '../security/request';
import { ONECLICK } from './deposits.resolver';
import { activeAccount, nowNs, storePreparedOp } from './payments.resolver';
import { amount } from './validation';
import { QuoteFees, QuoteView, feesOf, quoteView } from './quotes';

const OP_TTL_NS = 10n * 60n * 1_000_000_000n;
const DEADLINE_MS = 60 * 60 * 1000;

@ObjectType()
export class WithdrawalOption {
  @Field() key!: string;
  @Field() label!: string;
  @Field() network!: string;
}

@InputType()
export class PrepareWithdrawalInput {
  @Field() destination!: string;
  @Field() amount!: string;
  @Field() recipientAddress!: string;
}

@ObjectType()
export class WithdrawalView {
  @Field(() => ID) withdrawalId!: string;
  @Field() destination!: string;
  @Field() recipient!: string;
  @Field() amountIn!: string;
  @Field() amountOut!: string;
  @Field() minAmountOut!: string;
  @Field() status!: string;
  @Field(() => [String]) destinationTxHashes!: string[];
  @Field(() => String, { nullable: true }) nearTxHash!: string | null;
  @Field(() => Int, { nullable: true }) timeEstimateSeconds!: number | null;
  @Field() createdAt!: string;
  @Field(() => QuoteFees) fees!: QuoteFees;
}

@ObjectType()
export class PreparedWithdrawal {
  @Field(() => WithdrawalView) withdrawal!: WithdrawalView;
  @Field(() => PreparedOp) op!: PreparedOp;
}

export function withdrawalDestinations(config: AppConfig): DestinationAsset[] {
  if (config.WITHDRAW_DESTINATIONS) return parseDestinations(config.WITHDRAW_DESTINATIONS);
  return config.NEAR_NETWORK === 'mainnet' ? MAINNET_DESTINATIONS : [];
}

interface WithdrawalRow {
  id: string;
  destination: string;
  recipient: string;
  amount_in: string;
  amount_out: string;
  min_amount_out: string;
  status: string;
  tx_hashes: { destination?: string[]; near?: string };
  quote: { quote?: Record<string, unknown> & { timeEstimate?: unknown } };
  created_at: Date;
}

function toView(w: WithdrawalRow, appFeeBps: number): WithdrawalView {
  return {
    withdrawalId: w.id,
    destination: w.destination,
    recipient: w.recipient,
    amountIn: w.amount_in,
    amountOut: w.amount_out,
    minAmountOut: w.min_amount_out,
    status: w.status,
    destinationTxHashes: Array.isArray(w.tx_hashes?.destination) ? w.tx_hashes.destination : [],
    nearTxHash: typeof w.tx_hashes?.near === 'string' ? w.tx_hashes.near : null,
    timeEstimateSeconds: typeof w.quote?.quote?.timeEstimate === 'number' ? w.quote.quote.timeEstimate : null,
    createdAt: new Date(w.created_at).toISOString(),
    fees: feesOf(w.quote?.quote, appFeeBps),
  };
}

const COLUMNS = 'id, destination, recipient, amount_in::text, amount_out, min_amount_out, status, tx_hashes, quote, created_at';

@Resolver()
export class WithdrawalsResolver {
  private readonly destinations: Map<string, DestinationAsset>;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ONECLICK) private readonly oneclick: OneClickClient,
    private readonly chain: NearChain,
    private readonly audit: AuditService,
  ) {
    this.destinations = new Map(withdrawalDestinations(config).map((d) => [d.key, d]));
  }

  @Query(() => [WithdrawalOption])
  withdrawalOptions(): WithdrawalOption[] {
    return [...this.destinations.values()].map(({ key, label, network }) => ({ key, label, network }));
  }

  private async quoteBody(uid: string, input: PrepareWithdrawalInput, dry: boolean) {
    const dest = this.destinations.get(input.destination);
    if (!dest) throw appError('BAD_INPUT', 'destination');
    if (!validRefundAddress(dest.chain, input.recipientAddress)) throw appError('BAD_INPUT', 'recipientAddress');
    const units = amount(input.amount, USDC_DECIMALS, this.config.MAX_OP_AMOUNT);
    const accountId = await withUserTx(this.pool, uid, (c) => activeAccount(c, uid));
    const originAsset = `nep141:${this.config.USDC_CONTRACT}`;
    const body: QuoteRequest = {
      dry,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: dest.assetId,
      amount: units.toString(),
      refundTo: accountId,
      refundType: 'ORIGIN_CHAIN',
      recipient: input.recipientAddress,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + DEADLINE_MS).toISOString(),
      ...(this.config.ONECLICK_APP_FEE_BPS > 0 ? { appFees: [{ recipient: this.config.ONECLICK_FEE_RECIPIENT!, fee: this.config.ONECLICK_APP_FEE_BPS }] } : {}),
    };
    return { dest, units, accountId, originAsset, body };
  }

  private async fetchQuote(body: QuoteRequest) {
    try {
      return await this.oneclick.quote(body);
    } catch (err) {
      if (err instanceof OneClickError && err.code !== 'ONECLICK_UNAVAILABLE') {
        throw appError('BAD_INPUT', err.code === 'RECIPIENT_INVALID' ? 'recipientAddress' : 'amount');
      }
      throw appError('SERVICE_PAUSED');
    }
  }

  @Mutation(() => QuoteView)
  @RateLimit('quote')
  @KillSwitch('withdrawals')
  async quoteWithdrawal(@Context('req') req: ObibaRequest, @Args('input') input: PrepareWithdrawalInput): Promise<QuoteView> {
    const { uid } = identityOf(req);
    const { dest, units, originAsset, body } = await this.quoteBody(uid, input, true);
    const res = await this.fetchQuote(body);
    const check = checkSignedQuote(res, body, { signedAssetIds: [originAsset] }, this.config.ONECLICK_QUOTE_PUBLIC_KEY, { dry: true });
    if (!check.ok) {
      await this.audit.record({ actor: uid, action: 'withdrawal.quote', outcome: 'DENIED', requestId: req.requestId, details: { reason: check.reason, dry: true } });
      throw appError('SERVICE_PAUSED');
    }
    return quoteView(dest.key, res.quote, units.toString(), this.config.ONECLICK_APP_FEE_BPS);
  }

  @Mutation(() => PreparedWithdrawal)
  @RateLimit('quote')
  @KillSwitch('withdrawals')
  async prepareWithdrawal(@Context('req') req: ObibaRequest, @Args('input') input: PrepareWithdrawalInput): Promise<PreparedWithdrawal> {
    const { uid } = identityOf(req);
    const { dest, units, accountId, originAsset, body } = await this.quoteBody(uid, input, false);
    const res = await this.fetchQuote(body);
    const check = checkSignedQuote(res, body, { signedAssetIds: [originAsset] }, this.config.ONECLICK_QUOTE_PUBLIC_KEY);
    const q = res.quote;
    const depositAddress = String(q.depositAddress ?? '');
    const amountOut = String(q.amountOut ?? '');
    const minOut = String(q.minAmountOut ?? '');
    const sane =
      check.ok &&
      isNearAccountId(depositAddress) &&
      !q.depositMemo &&
      /^[1-9]\d{0,38}$/.test(amountOut) &&
      /^[1-9]\d{0,38}$/.test(minOut) &&
      String(q.amountIn ?? units) === units.toString();
    if (!sane) {
      await this.audit.record({ actor: uid, action: 'withdrawal.quote', outcome: 'DENIED', requestId: req.requestId, details: { reason: check.ok ? 'quote_shape' : check.reason } });
      throw appError('SERVICE_PAUSED');
    }
    let registered: boolean;
    try {
      registered = await this.chain.storageRegistered(this.config.USDC_CONTRACT, depositAddress);
    } catch {
      throw appError('SERVICE_PAUSED');
    }
    if (!registered) throw appError('RECIPIENT_NOT_REGISTERED', 'destination');
    return withUserTx(this.pool, uid, async (c) => {
      const account = await activeAccount(c, uid);
      if (account !== accountId) throw appError('CONFLICT');
      const op: Op = {
        op_id: newHexId(),
        kind: 'Transfer',
        token: this.config.USDC_CONTRACT,
        receiver: depositAddress,
        amount: units.toString(),
        expires_at_ns: (nowNs() + OP_TTL_NS).toString(),
        memo: null,
      };
      const prepared = await storePreparedOp(c, this.config, uid, accountId, op, 'execute', { op, guardian_sig: null }, null);
      let row: WithdrawalRow;
      try {
        row = (
          await c.query<WithdrawalRow>(
            `insert into ops.withdrawals(uid, account_id, op_id, destination, recipient, deposit_address, amount_in, amount_out, min_amount_out, quote, status)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PREPARED') returning ${COLUMNS}`,
            [uid, accountId, op.op_id, dest.key, input.recipientAddress, depositAddress, units.toString(), amountOut, minOut, JSON.stringify(res)],
          )
        ).rows[0]!;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw appError('CONFLICT');
        throw err;
      }
      await this.audit.record({ actor: uid, action: 'withdrawal.prepare', target: row.id, outcome: 'ALLOWED', requestId: req.requestId, details: { op_id: op.op_id } }, c);
      return { withdrawal: toView(row, this.config.ONECLICK_APP_FEE_BPS), op: prepared };
    });
  }

  @Query(() => WithdrawalView, { nullable: true })
  async withdrawal(@Context('req') req: ObibaRequest, @Args('id') id: string): Promise<WithdrawalView | null> {
    const { uid } = identityOf(req);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw appError('BAD_INPUT', 'id');
    const r = await withUserTx(this.pool, uid, (c) => c.query<WithdrawalRow>(`select ${COLUMNS} from ops.withdrawals where id = $1`, [id]));
    return r.rows[0] ? toView(r.rows[0], this.config.ONECLICK_APP_FEE_BPS) : null;
  }

  @Query(() => [WithdrawalView])
  async withdrawals(@Context('req') req: ObibaRequest, @Args('first', { type: () => Int, defaultValue: 20 }) first: number): Promise<WithdrawalView[]> {
    const { uid } = identityOf(req);
    if (!Number.isInteger(first) || first < 1 || first > 50) throw appError('BAD_INPUT', 'first');
    const r = await withUserTx(this.pool, uid, (c) => c.query<WithdrawalRow>(`select ${COLUMNS} from ops.withdrawals order by created_at desc limit $1`, [first]));
    return r.rows.map((w) => toView(w, this.config.ONECLICK_APP_FEE_BPS));
  }
}
