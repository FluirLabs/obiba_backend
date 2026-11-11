import { Inject } from '@nestjs/common';
import { Args, Context, Field, ID, InputType, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import type { Pool } from 'pg';
import { withTx, withUserTx } from '@obiba/db';
import { invoicePreimage, isHexId, newHexId, sha256, UNCAPPED_USD, USDC_DECIMALS, type Invoice, type Op } from '@obiba/domain';
import { OneClickClient, OneClickError, checkSignedQuote, validRefundAddress, type OriginAsset, type QuoteRequest } from '@obiba/intents';
import { APP_CONFIG, appOrigin, explorerTxUrl, type AppConfig } from '../config';
import { appError } from '../errors';
import { CreatedInvoice, CreateInvoiceInput, InvoiceView, MerchantInvoice, PreparedOp } from '../graphql/types';
import { AuditService } from '../infra/audit';
import { InvoiceSigner } from '../infra/invoice-signer';
import { PG_POOL } from '../infra/tokens';
import { Public, RateLimit, RequireMerchant } from '../security/decorators';
import { KillSwitch } from '../security/kill-switch';
import { identityOf, type ObibaRequest } from '../security/request';
import { DepositOption, ONECLICK, depositOrigins } from './deposits.resolver';
import { activeAccount, nowNs, storePreparedOp } from './payments.resolver';
import { invoiceToken } from './tokens';
import { amount, parse, reference } from './validation';
import { NearChain } from '../infra/near-chain';
import { recoverySetUp } from '../infra/notify';
import { IdTokenVerifier } from '../security/identity';

const MINUTE_NS = 60_000_000_000n;
const OP_TTL_NS = 10n * MINUTE_NS;
const CROSSCHAIN_MARGIN_NS = 10n * MINUTE_NS;
const CROSSCHAIN_MIN_REMAINING_NS = 15n * MINUTE_NS;

@InputType()
export class StartInvoicePaymentInput {
  @Field() invoiceId!: string;
  @Field() origin!: string;
  @Field() refundAddress!: string;
}

@ObjectType()
export class InvoicePayment {
  @Field(() => ID) paymentId!: string;
  @Field() invoiceId!: string;
  @Field() origin!: string;
  @Field() depositAddress!: string;
  @Field(() => String, { nullable: true }) depositMemo!: string | null;
  @Field() amountIn!: string;
  @Field() minAmountIn!: string;
  @Field() deadline!: string;
  @Field(() => Int, { nullable: true }) timeEstimateSeconds!: number | null;
  @Field() status!: string;
  @Field(() => [String]) originTxHashes!: string[];
}

export function paymentUrl(config: AppConfig, invoiceId: string): string {
  return `${appOrigin(config)}/pay/${invoiceId}`;
}

interface PaymentRow {
  id: string;
  invoice_id: string;
  origin_asset: string;
  deposit_address: string;
  deposit_memo: string | null;
  amount_in: string;
  min_amount_in: string;
  deadline: string;
  time_estimate: number | null;
  status: string;
  tx_hashes: { origin?: unknown };
}

function toPayment(p: PaymentRow): InvoicePayment {
  const origin = Array.isArray(p.tx_hashes?.origin) ? p.tx_hashes.origin.filter((h): h is string => typeof h === 'string').slice(0, 10) : [];
  return {
    paymentId: p.id,
    invoiceId: p.invoice_id,
    origin: p.origin_asset,
    depositAddress: p.deposit_address,
    depositMemo: p.deposit_memo,
    amountIn: p.amount_in,
    minAmountIn: p.min_amount_in,
    deadline: p.deadline,
    timeEstimateSeconds: p.time_estimate,
    status: p.status,
    originTxHashes: origin,
  };
}

@Resolver()
export class InvoicesResolver {
  private readonly origins: Map<string, OriginAsset>;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly signer: InvoiceSigner,
    private readonly audit: AuditService,
    @Inject(ONECLICK) private readonly oneclick: OneClickClient,
    private readonly chain: NearChain,
    private readonly verifier: IdTokenVerifier,
  ) {
    this.origins = new Map(depositOrigins(config).map((o) => [o.key, o]));
  }

  @Mutation(() => CreatedInvoice)
  @RequireMerchant()
  @RateLimit('invoice_create')
  @KillSwitch('invoices')
  async createInvoice(@Context('req') req: ObibaRequest, @Args('input') input: CreateInvoiceInput): Promise<CreatedInvoice> {
    const { uid } = identityOf(req);
    const units = amount(input.amount, USDC_DECIMALS, UNCAPPED_USD);
    if (!Number.isInteger(input.expiresInMinutes) || input.expiresInMinutes < 1 || input.expiresInMinutes > 60) {
      throw appError('BAD_INPUT', 'expiresInMinutes');
    }
    const ref = input.reference == null ? null : parse(reference, input.reference, 'reference');
    const token = await invoiceToken(this.chain, this.config);
    return withUserTx(this.pool, uid, async (c) => {
      const merchant = await activeAccount(c, uid);
      if (!(await recoverySetUp(c, uid, this.verifier))) throw appError('RECOVERY_SETUP_REQUIRED');
      const invoice: Invoice = {
        invoice_id: newHexId(),
        merchant,
        token,
        amount: units.toString(),
        fee_bps: this.config.INVOICE_FEE_BPS,
        expires_at_ns: (nowNs() + BigInt(input.expiresInMinutes) * MINUTE_NS).toString(),
        reference: ref,
      };
      const digest = sha256(invoicePreimage(this.config.NEAR_NETWORK, this.config.PAY_CONTRACT, invoice));
      const signature = (await this.signer.sign(digest)).toString('base64');
      await c.query(
        `insert into ops.invoices(invoice_id, merchant_uid, merchant_account, token, amount, fee_bps, expires_at_ns, reference, signature, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN')`,
        [invoice.invoice_id, uid, merchant, invoice.token, invoice.amount, invoice.fee_bps, invoice.expires_at_ns, ref, signature],
      );
      await this.audit.record({ actor: uid, action: 'invoice.create', target: invoice.invoice_id, outcome: 'ALLOWED', requestId: req.requestId }, c);
      return {
        invoiceId: invoice.invoice_id,
        amount: invoice.amount,
        feeBps: invoice.fee_bps,
        expiresAtNs: invoice.expires_at_ns,
        signature,
        paymentUrl: paymentUrl(this.config, invoice.invoice_id),
      };
    });
  }

  @Query(() => InvoiceView, { nullable: true })
  @Public()
  @RateLimit('invoice_view')
  async invoice(@Args('invoiceId') invoiceId: string): Promise<InvoiceView | null> {
    if (!isHexId(invoiceId)) throw appError('BAD_INPUT', 'invoiceId');
    const r = await withTx(this.pool, (c) => c.query('select * from ops.public_invoice($1)', [invoiceId]));
    const i = r.rows[0];
    if (!i) return null;
    return {
      invoiceId: i.invoice_id,
      merchantName: i.merchant_name,
      merchantAccount: i.merchant_account,
      token: i.token,
      amount: i.amount,
      feeBps: i.fee_bps,
      expiresAtNs: i.expires_at_ns,
      status: i.status,
      paymentUrl: paymentUrl(this.config, i.invoice_id),
      crossChainEnabled: this.config.INVOICE_CROSSCHAIN,
    };
  }

  @Query(() => [MerchantInvoice])
  @RequireMerchant()
  async merchantInvoices(
    @Context('req') req: ObibaRequest,
    @Args('first', { type: () => Int, defaultValue: 20 }) first: number,
    @Args('before', { type: () => String, nullable: true }) before: string | null,
  ): Promise<MerchantInvoice[]> {
    const { uid } = identityOf(req);
    if (!Number.isInteger(first) || first < 1 || first > 100) throw appError('BAD_INPUT', 'first');
    if (before != null && Number.isNaN(Date.parse(before))) throw appError('BAD_INPUT', 'before');
    const r = await withUserTx(this.pool, uid, (c) =>
      c.query<{
        invoice_id: string;
        amount: string;
        fee_bps: number;
        expires_at_ns: string;
        reference: string | null;
        status: string;
        created_at: Date;
        paid_event: { payer?: string | null; fee?: string | null; net?: string | null; tx_hash?: string | null; paid_at?: string | null } | null;
      }>(
        `select invoice_id, amount::text, fee_bps, expires_at_ns::text, reference, status, created_at, paid_event from ops.invoices
          where ($2::timestamptz is null or created_at < $2::timestamptz) order by created_at desc limit $1`,
        [first, before ?? null],
      ),
    );
    const now = nowNs();
    return r.rows.map((i) => ({
      invoiceId: i.invoice_id,
      amount: i.amount,
      feeBps: i.fee_bps,
      expiresAtNs: i.expires_at_ns,
      reference: i.reference,
      status: i.status === 'OPEN' && BigInt(i.expires_at_ns) <= now ? 'EXPIRED' : i.status,
      paymentUrl: paymentUrl(this.config, i.invoice_id),
      createdAt: new Date(i.created_at).toISOString(),
      payer: i.paid_event?.payer ?? null,
      fee: i.paid_event?.fee ?? null,
      net: i.paid_event?.net ?? null,
      paidTxHash: i.paid_event?.tx_hash ?? null,
      paidExplorerUrl: explorerTxUrl(this.config, i.paid_event?.tx_hash ?? null),
      paidAt: i.paid_event?.paid_at ?? null,
    }));
  }

  @Query(() => [DepositOption])
  @Public()
  @RateLimit('invoice_view')
  invoicePayOptions(): DepositOption[] {
    if (!this.config.INVOICE_CROSSCHAIN) return [];
    return [...this.origins.values()].map(({ key, label, decimals, minUsd }) => ({ key, label, decimals, minUsd }));
  }

  @Mutation(() => InvoicePayment)
  @Public()
  @RateLimit('invoice_pay_quote')
  @KillSwitch('invoices', 'deposits')
  async startInvoicePayment(@Context('req') req: ObibaRequest, @Args('input') input: StartInvoicePaymentInput): Promise<InvoicePayment> {
    if (!this.config.INVOICE_CROSSCHAIN) throw appError('SERVICE_PAUSED');
    if (!isHexId(input.invoiceId)) throw appError('BAD_INPUT', 'invoiceId');
    const origin = this.origins.get(input.origin);
    if (!origin) throw appError('BAD_INPUT', 'origin');
    if (!validRefundAddress(origin.chain, input.refundAddress)) throw appError('BAD_INPUT', 'refundAddress');
    const r = await withTx(this.pool, (c) => c.query('select * from ops.invoice_for_crosschain($1)', [input.invoiceId]));
    const i = r.rows[0];
    if (!i) throw appError('NOT_FOUND', 'invoiceId');
    const expires = BigInt(i.expires_at_ns);
    const now = nowNs();
    if (expires - now < CROSSCHAIN_MIN_REMAINING_NS) throw appError('EXPIRED');
    const signedInvoice = {
      invoice: {
        invoice_id: i.invoice_id,
        merchant: i.merchant_account,
        token: i.token,
        amount: i.amount,
        fee_bps: i.fee_bps,
        expires_at_ns: i.expires_at_ns,
        reference: i.reference,
      },
      signature: i.signature,
    };
    const body: QuoteRequest = {
      dry: false,
      swapType: 'EXACT_OUTPUT',
      slippageTolerance: 100,
      originAsset: origin.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: `nep141:${i.token}`,
      amount: i.amount,
      refundTo: input.refundAddress,
      refundType: 'ORIGIN_CHAIN',
      recipient: this.config.PAY_CONTRACT,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Number((expires - CROSSCHAIN_MARGIN_NS) / 1_000_000n)).toISOString(),
      customRecipientMsg: JSON.stringify(signedInvoice),
      ...(this.config.ONECLICK_APP_FEE_BPS > 0 ? { appFees: [{ recipient: this.config.ONECLICK_FEE_RECIPIENT!, fee: this.config.ONECLICK_APP_FEE_BPS }] } : {}),
    };
    let res;
    try {
      res = await this.oneclick.quote(body);
    } catch (err) {
      if (err instanceof OneClickError && err.code !== 'ONECLICK_UNAVAILABLE') {
        throw appError('BAD_INPUT', err.code === 'RECIPIENT_INVALID' ? 'refundAddress' : 'origin');
      }
      throw appError('SERVICE_PAUSED');
    }
    const check = checkSignedQuote(res, body, origin, this.config.ONECLICK_QUOTE_PUBLIC_KEY);
    const q = res.quote;
    if (!check.ok || String(q.amountOut ?? '') !== i.amount) {
      await this.audit.record({ actor: 'public', action: 'invoice.crosschain_quote', target: i.invoice_id, outcome: 'DENIED', requestId: req.requestId, details: { reason: check.ok ? 'amount_out' : check.reason } });
      throw appError('SERVICE_PAUSED');
    }
    const memo = q.depositMemo ? String(q.depositMemo) : null;
    let id: string | null;
    try {
      id = await withTx(this.pool, async (c) => {
        const ins = await c.query<{ id: string | null }>('select ops.start_invoice_deposit($1, $2, $3, $4, $5, $6, $7) as id', [
          i.invoice_id,
          origin.key,
          String(q.depositAddress),
          memo,
          String(q.amountIn ?? ''),
          input.refundAddress,
          JSON.stringify(res),
        ]);
        return ins.rows[0]?.id ?? null;
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw appError('CONFLICT', 'invoiceId');
      throw err;
    }
    if (!id) throw appError('CONFLICT', 'invoiceId');
    await this.audit.record({ actor: 'public', action: 'invoice.crosschain_start', target: i.invoice_id, outcome: 'ALLOWED', requestId: req.requestId, details: { payment_id: id } });
    const p = await withTx(this.pool, (c) => c.query<PaymentRow>('select * from ops.public_invoice_deposit($1)', [id]));
    return toPayment(p.rows[0]!);
  }

  @Query(() => InvoicePayment, { nullable: true })
  @Public()
  @RateLimit('invoice_view')
  async invoicePayment(@Args('paymentId') paymentId: string): Promise<InvoicePayment | null> {
    if (!/^[0-9a-f-]{36}$/.test(paymentId)) throw appError('BAD_INPUT', 'paymentId');
    const p = await withTx(this.pool, (c) => c.query<PaymentRow>('select * from ops.public_invoice_deposit($1)', [paymentId]));
    return p.rows[0] ? toPayment(p.rows[0]) : null;
  }

  @Mutation(() => PreparedOp)
  @RateLimit('quote')
  @KillSwitch('invoices', 'transfers')
  async prepareInvoicePayment(@Context('req') req: ObibaRequest, @Args('invoiceId') invoiceId: string): Promise<PreparedOp> {
    const { uid } = identityOf(req);
    if (!isHexId(invoiceId)) throw appError('BAD_INPUT', 'invoiceId');
    return withUserTx(this.pool, uid, async (c) => {
      const accountId = await activeAccount(c, uid);
      const r = await c.query('select * from ops.invoice_for_payment($1)', [invoiceId]);
      const i = r.rows[0];
      if (!i) throw appError('NOT_FOUND', 'invoiceId');
      if (i.merchant_account === accountId) throw appError('BAD_INPUT', 'invoiceId');
      const now = nowNs();
      if (BigInt(i.expires_at_ns) <= now) throw appError('EXPIRED');
      const signedInvoice = {
        invoice: {
          invoice_id: i.invoice_id,
          merchant: i.merchant_account,
          token: i.token,
          amount: i.amount,
          fee_bps: i.fee_bps,
          expires_at_ns: i.expires_at_ns,
          reference: i.reference,
        },
        signature: i.signature,
      };
      const opExpiry = now + OP_TTL_NS < BigInt(i.expires_at_ns) ? now + OP_TTL_NS : BigInt(i.expires_at_ns);
      const op: Op = {
        op_id: newHexId(),
        kind: 'PayInvoice',
        token: i.token,
        receiver: this.config.PAY_CONTRACT,
        amount: i.amount,
        expires_at_ns: opExpiry.toString(),
        memo: i.invoice_id,
      };
      return storePreparedOp(c, this.config, uid, accountId, op, 'pay_invoice', { op, invoice: signedInvoice, guardian_sig: null }, invoiceId);
    });
  }
}
