import { randomInt } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { Args, Context, Field, ID, InputType, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import type { Pool, PoolClient } from 'pg';
import { settleSandboxOp, withUserTx } from '@obiba/db';
import {
  REMIT_CORRIDORS,
  SANDBOX_CURRENCY,
  SANDBOX_KINDS,
  SANDBOX_NOTICE,
  SANDBOX_PRODUCTS,
  SandboxInputError,
  formatGhs,
  invoicePreimage,
  localRailProvider,
  newHexId,
  sandboxQuote,
  sha256,
  type Invoice,
  type RemitCountry,
  type Op,
  type SandboxQuote as Quote,
} from '@obiba/domain';
import { APP_CONFIG, type AppConfig } from '../config';
import { ensureSandboxMirror } from './sandbox-mirror';
import { InvoiceSigner } from '../infra/invoice-signer';
import { AuditService } from '../infra/audit';
import { PreparedOp } from '../graphql/types';
import { activeAccount, nowNs, storePreparedOp } from './payments.resolver';
import { appError } from '../errors';
import { FxRates } from '../infra/fx';
import { NearChain } from '../infra/near-chain';
import { invoiceToken } from './tokens';
import { Balance } from '../graphql/types';
import { PG_POOL } from '../infra/tokens';
import { RateLimit } from '../security/decorators';
import { KillSwitch } from '../security/kill-switch';
import { identityOf, type ObibaRequest } from '../security/request';

export { SANDBOX_NOTICE };

const HOLD_TTL = '30 days';
const INTERNAL_INVOICE_TTL_NS = 15n * 60n * 1_000_000_000n;
const OP_TTL_NS = 10n * 60n * 1_000_000_000n;

export function internalTestNotice(label: string): string {
  return `Paid on-chain. ${label} provider settlement is in pilot.`;
}

@InputType()
export class SandboxRequestInput {
  @Field() kind!: string;
  @Field(() => String, { nullable: true }) provider?: string | null;
  @Field() target!: string;
  @Field(() => String, { nullable: true }) amountGhs?: string | null;
  @Field(() => String, { nullable: true }) amountLocal?: string | null;
  @Field(() => String, { nullable: true }) country?: string | null;
  @Field(() => String, { nullable: true }) productId?: string | null;
  @Field(() => String, { nullable: true }) recipientName?: string | null;
}

@ObjectType()
export class SandboxQuoteView {
  @Field() kind!: string;
  @Field() direction!: string;
  @Field() provider!: string;
  @Field() target!: string;
  @Field(() => String, { nullable: true }) productId!: string | null;
  @Field(() => String, { nullable: true }) productLabel!: string | null;
  @Field(() => String, { nullable: true }) amountGhs!: string | null;
  @Field(() => String, { nullable: true }) feeGhs!: string | null;
  @Field(() => String, { nullable: true }) totalGhs!: string | null;
  @Field() country!: string;
  @Field() localCurrency!: string;
  @Field() amountLocal!: string;
  @Field() feeLocal!: string;
  @Field() totalLocal!: string;
  @Field() amount!: string;
  @Field() fee!: string;
  @Field() total!: string;
  @Field() currency!: string;
  @Field() simulatedRate!: string;
  @Field() rateSource!: string;
  @Field(() => String, { nullable: true }) rateAsOf!: string | null;
  @Field() notice!: string;
}

@ObjectType()
export class SandboxReceiptView {
  @Field(() => ID) id!: string;
  @Field() kind!: string;
  @Field() provider!: string;
  @Field() target!: string;
  @Field() status!: string;
  @Field() amount!: string;
  @Field() currency!: string;
  @Field(() => String, { nullable: true }) amountGhs!: string | null;
  @Field(() => String, { nullable: true }) feeGhs!: string | null;
  @Field(() => String, { nullable: true }) country!: string | null;
  @Field(() => String, { nullable: true }) localCurrency!: string | null;
  @Field(() => String, { nullable: true }) amountLocal!: string | null;
  @Field(() => String, { nullable: true }) feeLocal!: string | null;
  @Field(() => String, { nullable: true }) token!: string | null;
  @Field() notice!: string;
  @Field() createdAt!: string;
  @Field() funding!: string;
  @Field(() => String, { nullable: true }) invoiceId!: string | null;
  @Field(() => String, { nullable: true }) opId!: string | null;
  @Field(() => String, { nullable: true }) recipientName!: string | null;
}

@ObjectType()
export class InternalTestPayment {
  @Field(() => SandboxReceiptView) receipt!: SandboxReceiptView;
  @Field(() => PreparedOp) op!: PreparedOp;
}

@ObjectType()
export class SandboxProviderView {
  @Field() kind!: string;
  @Field() label!: string;
  @Field() direction!: string;
  @Field(() => [String]) providers!: string[];
  @Field() target!: string;
  @Field(() => Int) feeBps!: number;
  @Field() usesProducts!: boolean;
}

@ObjectType()
export class SandboxProductView {
  @Field() id!: string;
  @Field() provider!: string;
  @Field() label!: string;
  @Field() priceGhs!: string;
}

@ObjectType()
export class RemittanceMethod {
  @Field() kind!: string;
  @Field() type!: string;
  @Field() label!: string;
  @Field(() => [String]) providers!: string[];
  @Field() target!: string;
  @Field(() => Int) feeBps!: number;
}

@ObjectType()
export class RemittanceCorridor {
  @Field() country!: string;
  @Field() countryName!: string;
  @Field() currency!: string;
  @Field() maxAmount!: string;
  @Field() provider!: string;
  @Field(() => String, { nullable: true }) rate!: string | null;
  @Field(() => String, { nullable: true }) rateSource!: string | null;
  @Field(() => String, { nullable: true }) rateAsOf!: string | null;
  @Field(() => [RemittanceMethod]) methods!: RemittanceMethod[];
}

@ObjectType()
export class SandboxCatalog {
  @Field(() => [SandboxProviderView]) services!: SandboxProviderView[];
  @Field(() => [SandboxProductView]) products!: SandboxProductView[];
  @Field(() => String, { nullable: true }) simulatedRate!: string | null;
  @Field(() => String, { nullable: true }) rateSource!: string | null;
  @Field(() => String, { nullable: true }) rateAsOf!: string | null;
  @Field() currency!: string;
  @Field() notice!: string;
}

interface OpRow {
  id: string;
  kind: string;
  provider: string;
  target: string;
  status: string;
  amount: string;
  quote: { amount_ghs?: string; fee_ghs?: string; amount_local?: string; fee_local?: string; currency?: string; country?: string } | null;
  receipt: { token?: string | null; notice?: string; recipient_name?: string | null } | null;
  created_at: Date;
  funding: string;
  invoice_id: string | null;
  op_id: string | null;
}

const COLUMNS = 'id, kind, provider, target, status, amount::text, quote, receipt, created_at, funding, invoice_id, op_id';

interface LiveRate {
  rate: string;
  source: string;
  asOf: string | null;
}

function quoteView(q: Quote, fx: LiveRate): SandboxQuoteView {
  return {
    kind: q.kind,
    direction: q.direction,
    provider: q.provider,
    target: q.target,
    productId: q.productId,
    productLabel: q.productLabel,
    amountGhs: q.currency === 'GHS' ? formatGhs(q.amountMinor) : null,
    feeGhs: q.currency === 'GHS' ? formatGhs(q.feeMinor) : null,
    totalGhs: q.currency === 'GHS' ? formatGhs(q.totalMinor) : null,
    country: q.country,
    localCurrency: q.currency,
    amountLocal: formatGhs(q.amountMinor),
    feeLocal: formatGhs(q.feeMinor),
    totalLocal: formatGhs(q.totalMinor),
    amount: q.amountUnits.toString(),
    fee: q.feeUnits.toString(),
    total: q.totalUnits.toString(),
    currency: SANDBOX_CURRENCY,
    simulatedRate: q.rate,
    rateSource: fx.source,
    rateAsOf: fx.asOf,
    notice: SANDBOX_NOTICE,
  };
}

function receiptView(r: OpRow): SandboxReceiptView {
  return {
    id: r.id,
    kind: r.kind,
    provider: r.provider,
    target: r.target,
    status: r.status,
    amount: r.amount,
    currency: r.funding === 'REAL_INTERNAL' ? 'USDC' : SANDBOX_CURRENCY,
    amountGhs: r.quote?.amount_ghs ?? null,
    feeGhs: r.quote?.fee_ghs ?? null,
    country: r.quote?.country ?? (r.quote?.amount_ghs ? 'GH' : null),
    localCurrency: r.quote?.currency ?? (r.quote?.amount_ghs ? 'GHS' : null),
    amountLocal: r.quote?.amount_local ?? r.quote?.amount_ghs ?? null,
    feeLocal: r.quote?.fee_local ?? r.quote?.fee_ghs ?? null,
    token: r.receipt?.token ?? null,
    notice: r.receipt?.notice ?? SANDBOX_NOTICE,
    createdAt: new Date(r.created_at).toISOString(),
    funding: r.funding,
    invoiceId: r.invoice_id,
    opId: r.op_id,
    recipientName: r.receipt?.recipient_name ?? null,
  };
}

function recipientNameOf(input: SandboxRequestInput): string | null {
  const name = input.recipientName?.trim().replace(/\s+/g, ' ') ?? '';
  if (!name) return null;
  if (name.length > 80 || !/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(name)) throw appError('BAD_INPUT', 'recipientName');
  if (input.kind !== 'MOMO_PAYOUT' && input.kind !== 'BANK_PAYOUT') throw appError('BAD_INPUT', 'recipientName');
  return name;
}

function storedAmounts(q: Quote): Record<string, string> {
  const local = { amount_local: formatGhs(q.amountMinor), fee_local: formatGhs(q.feeMinor), currency: q.currency, country: q.country };
  return q.currency === 'GHS' ? { ...local, amount_ghs: local.amount_local, fee_ghs: local.fee_local } : local;
}

function corridorOf(input: SandboxRequestInput): (typeof REMIT_CORRIDORS)[RemitCountry] {
  const c = REMIT_CORRIDORS[(input.country ?? 'GH') as RemitCountry];
  if (!c) throw appError('BAD_INPUT', 'country');
  return c;
}

function tokenDigits(): string {
  return Array.from({ length: 20 }, () => randomInt(10)).join('');
}

@Resolver()
export class SandboxResolver {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly signer: InvoiceSigner,
    private readonly audit: AuditService,
    private readonly fx: FxRates,
    private readonly chain: NearChain,
  ) {}

  private async liveRate(currency = 'GHS'): Promise<LiveRate | null> {
    if (this.config.FX_PROVIDER === 'off') return currency === 'GHS' ? { rate: this.config.SANDBOX_GHS_PER_USD, source: 'pilot', asOf: null } : null;
    const v = await this.fx.usdRate(currency);
    if (!v) return null;
    const m = /^(\d{1,6})(?:\.(\d+))?$/.exec(v.rate);
    if (!m || m[1] === '0') return null;
    const frac = (m[2] ?? '').slice(0, 4).replace(/0+$/, '');
    return { rate: frac ? `${m[1]}.${frac}` : m[1]!, source: v.source, asOf: v.asOf };
  }

  private async requireRate(currency = 'GHS'): Promise<LiveRate> {
    const r = await this.liveRate(currency);
    if (!r) throw appError('SERVICE_PAUSED', 'rate');
    return r;
  }

  private quote(input: SandboxRequestInput, fx: LiveRate): Quote {
    try {
      const checked = sandboxQuote(input, fx.rate);
      return localRailProvider(checked.kind, checked.provider, fx.rate).quote(input);
    } catch (err) {
      if (err instanceof SandboxInputError) throw appError('BAD_INPUT', err.field);
      throw err;
    }
  }

  @Query(() => SandboxCatalog)
  async sandboxCatalog(): Promise<SandboxCatalog> {
    const fx = await this.liveRate();
    return {
      services: Object.values(SANDBOX_KINDS).map((k) => ({ kind: k.kind, label: k.label, direction: k.direction, providers: k.providers, target: k.target, feeBps: k.feeBps, usesProducts: k.usesProducts })),
      products: SANDBOX_PRODUCTS.map((p) => ({ id: p.id, provider: p.provider, label: p.label, priceGhs: formatGhs(p.priceGhsPesewas) })),
      simulatedRate: fx?.rate ?? null,
      rateSource: fx?.source ?? null,
      rateAsOf: fx?.asOf ?? null,
      currency: SANDBOX_CURRENCY,
      notice: SANDBOX_NOTICE,
    };
  }

  @Query(() => [RemittanceCorridor])
  async remittanceCorridors(): Promise<RemittanceCorridor[]> {
    return Promise.all(
      Object.values(REMIT_CORRIDORS).map(async (c) => {
        const fx = await this.liveRate(c.currency);
        const methods: RemittanceMethod[] = c.methods.map((m) => {
          const k = SANDBOX_KINDS[m.kind];
          return { kind: m.kind, type: m.kind === 'MOMO_PAYOUT' ? 'MOBILE_MONEY' : 'BANK', label: k.label, providers: m.providers, target: m.target, feeBps: k.feeBps };
        });
        return { country: c.country, countryName: c.name, currency: c.currency, maxAmount: formatGhs(c.maxMinor), provider: 'pilot', rate: fx?.rate ?? null, rateSource: fx?.source ?? null, rateAsOf: fx?.asOf ?? null, methods };
      }),
    );
  }

  @Query(() => SandboxQuoteView)
  @RateLimit('sandbox')
  async sandboxQuote(@Args('input') input: SandboxRequestInput): Promise<SandboxQuoteView> {
    const fx = await this.requireRate(corridorOf(input).currency);
    return quoteView(this.quote(input, fx), fx);
  }

  @Query(() => Balance)
  async demoBalance(@Context('req') req: ObibaRequest): Promise<Balance> {
    const { uid } = identityOf(req);
    const r = await withUserTx(this.pool, uid, async (c) => {
      await ensureSandboxMirror(c, uid);
      return c.query<{ posted: string; held: string; available: string }>("select posted, held, available from ledger.my_balances() where domain = 'DEMO'");
    });
    const b = r.rows[0];
    return { domain: 'DEMO', currency: SANDBOX_CURRENCY, posted: b?.posted ?? '0', held: b?.held ?? '0', available: b?.available ?? '0' };
  }

  @Mutation(() => SandboxReceiptView)
  @RateLimit('sandbox')
  @KillSwitch('sandbox')
  async sandboxSubmit(@Context('req') req: ObibaRequest, @Args('input') input: SandboxRequestInput): Promise<SandboxReceiptView> {
    const { uid } = identityOf(req);
    const fx = await this.requireRate(corridorOf(input).currency);
    const q = this.quote(input, fx);
    return withUserTx(this.pool, uid, async (c) => {
      await ensureSandboxMirror(c, uid);
      const ref = newHexId();
      const rail = localRailProvider(q.kind, q.provider, q.rate);
      const stored = {
        amount_units: q.amountUnits.toString(),
        fee_units: q.feeUnits.toString(),
        total_units: q.totalUnits.toString(),
        ...storedAmounts(q),
        rate: q.rate,
        product_id: q.productId,
        simulated: true,
      };
      const r = await c.query<OpRow>(
        `insert into ops.sandbox_ops(uid, kind, provider, target, amount, status, receipt, quote)
         values ($1, $2, $3, $4, $5, 'PENDING', $6, $7) returning ${COLUMNS}`,
        [uid, q.kind, q.provider, q.target, q.totalUnits.toString(), JSON.stringify({ ref, notice: SANDBOX_NOTICE, sandbox: true, rail: rail.name, recipient_name: recipientNameOf(input) }), JSON.stringify(stored)],
      );
      const op = r.rows[0]!;
      const started = rail.initiate({ id: op.id, kind: q.kind, provider: q.provider, target: q.target, amountUnits: q.amountUnits, providerRef: null });
      await c.query("update ops.sandbox_ops set receipt = receipt || $2::jsonb where id = $1", [op.id, JSON.stringify({ provider_ref: started.providerRef })]);
      if (q.direction === 'DEBIT') {
        const user = await c.query<{ id: string }>("select ledger.ensure_account('DEMO', 'DEMO_USER', $1, $2) as id", [`demo:${uid}`, SANDBOX_CURRENCY]);
        try {
          await c.query('select ledger.place_hold($1, $2, $3, now() + $4::interval)', [`sandbox:${op.id}`, user.rows[0]!.id, q.totalUnits.toString(), HOLD_TTL]);
        } catch (err) {
          if ((err as { code?: string }).code === '23514') throw appError('INSUFFICIENT_FUNDS');
          throw err;
        }
      }
      return receiptView(op);
    });
  }

  @Mutation(() => InternalTestPayment)
  @RateLimit('money')
  @KillSwitch('sandbox', 'transfers')
  async prepareInternalTestPayment(@Context('req') req: ObibaRequest, @Args('input') input: SandboxRequestInput): Promise<InternalTestPayment> {
    const { uid } = identityOf(req);
    const handle = this.config.INTERNAL_TEST_BILLERS[input.kind];
    if (!handle) throw appError('BAD_INPUT', 'kind');
    if (input.country && input.country !== 'GH') throw appError('BAD_INPUT', 'country');
    const fx = await this.requireRate();
    const q = this.quote(input, fx);
    if (q.direction !== 'DEBIT') throw appError('BAD_INPUT', 'kind');
    if (q.totalUnits > this.config.INTERNAL_TEST_MAX_UNITS) throw appError('BAD_INPUT', 'amountGhs');
    return withUserTx(this.pool, uid, async (c) => {
      const tester = await c.query<{ internal_tester: boolean }>('select internal_tester from identity.users where uid = $1', [uid]);
      if (!tester.rows[0]?.internal_tester) throw appError('FORBIDDEN');
      const accountId = await activeAccount(c, uid);
      const biller = (await c.query<{ account: string | null }>('select ops.internal_biller_account($1) as account', [handle])).rows[0]?.account;
      if (!biller) throw appError('SERVICE_PAUSED');
      if (biller === accountId) throw appError('BAD_INPUT', 'kind');
      const now = nowNs();
      const invoice: Invoice = {
        invoice_id: newHexId(),
        merchant: biller,
        token: await invoiceToken(this.chain, this.config),
        amount: q.totalUnits.toString(),
        fee_bps: this.config.INVOICE_FEE_BPS,
        expires_at_ns: (now + INTERNAL_INVOICE_TTL_NS).toString(),
        reference: `TEST-${q.kind}`,
      };
      const signature = (await this.signer.sign(sha256(invoicePreimage(this.config.NEAR_NETWORK, this.config.PAY_CONTRACT, invoice)))).toString('base64');
      await c.query('select * from ops.create_internal_test_invoice($1, $2, $3, $4, $5, $6, $7, $8)', [
        invoice.invoice_id,
        handle,
        invoice.token,
        invoice.amount,
        invoice.fee_bps,
        invoice.expires_at_ns,
        invoice.reference,
        signature,
      ]);
      const label = SANDBOX_KINDS[q.kind].label;
      const stored = { amount_units: q.amountUnits.toString(), fee_units: q.feeUnits.toString(), total_units: q.totalUnits.toString(), ...storedAmounts(q), rate: q.rate, internal_test: true };
      const row = (
        await c.query<OpRow>(
          `insert into ops.sandbox_ops(uid, kind, provider, target, amount, status, receipt, quote, funding, invoice_id)
           values ($1, $2, $3, $4, $5, 'PENDING', $6, $7, 'REAL_INTERNAL', $8) returning ${COLUMNS}`,
          [uid, q.kind, q.provider, q.target, q.totalUnits.toString(), JSON.stringify({ ref: newHexId(), notice: internalTestNotice(label), internal_test: true }), JSON.stringify(stored), invoice.invoice_id],
        )
      ).rows[0]!;
      const opExpiry = now + OP_TTL_NS;
      const op: Op = { op_id: newHexId(), kind: 'PayInvoice', token: invoice.token, receiver: this.config.PAY_CONTRACT, amount: invoice.amount, expires_at_ns: opExpiry.toString(), memo: invoice.invoice_id };
      const prepared = await storePreparedOp(c, this.config, uid, accountId, op, 'pay_invoice', { op, invoice: { invoice, signature }, guardian_sig: null }, invoice.invoice_id);
      const updated = (await c.query<OpRow>(`update ops.sandbox_ops set op_id = $2 where id = $1 returning ${COLUMNS}`, [row.id, op.op_id])).rows[0]!;
      await this.audit.record({ actor: uid, action: 'internal_test.prepare', target: row.id, outcome: 'ALLOWED', requestId: req.requestId, details: { kind: q.kind, biller, amount: invoice.amount } }, c);
      return { receipt: receiptView(updated), op: prepared };
    });
  }

  private async load(c: PoolClient, id: string): Promise<OpRow | null> {
    await settleSandboxOp(c, id, this.config.SANDBOX_SETTLE_SECONDS, tokenDigits);
    const r = await c.query<OpRow>(`select ${COLUMNS} from ops.sandbox_ops where id = $1`, [id]);
    return r.rows[0] ?? null;
  }

  @Query(() => SandboxReceiptView, { nullable: true })
  async sandboxOp(@Context('req') req: ObibaRequest, @Args('id') id: string): Promise<SandboxReceiptView | null> {
    const { uid } = identityOf(req);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw appError('BAD_INPUT', 'id');
    const r = await withUserTx(this.pool, uid, (c) => this.load(c, id));
    return r ? receiptView(r) : null;
  }

  @Query(() => [SandboxReceiptView])
  async sandboxOps(@Context('req') req: ObibaRequest, @Args('first', { type: () => Int, defaultValue: 20 }) first: number): Promise<SandboxReceiptView[]> {
    const { uid } = identityOf(req);
    if (!Number.isInteger(first) || first < 1 || first > 50) throw appError('BAD_INPUT', 'first');
    return withUserTx(this.pool, uid, async (c) => {
      const pending = await c.query<{ id: string }>("select id from ops.sandbox_ops where status = 'PENDING' order by created_at limit 20");
      for (const p of pending.rows) await settleSandboxOp(c, p.id, this.config.SANDBOX_SETTLE_SECONDS, tokenDigits);
      const r = await c.query<OpRow>(`select ${COLUMNS} from ops.sandbox_ops order by created_at desc limit $1`, [first]);
      return r.rows.map(receiptView);
    });
  }
}
