import { randomBytes, randomInt } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import type Redis from 'ioredis';
import type { Pool, PoolClient } from 'pg';
import { withTx, withUserTx } from '@obiba/db';
import { publishUserEvents } from '@obiba/domain';
import { appError } from '../errors';
import {
  BusinessView,
  CheckoutItemView,
  CheckoutPaymentView,
  CheckoutPayResult,
  CheckoutView,
  CommerceView,
  CreateBusinessInput,
  CreatePaymentLinkInput,
  PublicCheckoutView,
} from '../graphql/types';
import { AuditService } from '../infra/audit';
import { FxRates } from '../infra/fx';
import { PG_POOL, REDIS } from '../infra/tokens';
import { Public, RateLimit } from '../security/decorators';
import { identityOf, type ObibaRequest } from '../security/request';
import { activeAccount } from './payments.resolver';

const FEE_BPS = 100;
const QUOTE_SECONDS = 600;
const SETTLE_SECONDS = 3;
const REFUND_SECONDS = 5;
const MAX_AMOUNT = 5_000_000n;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EXPIRY_MINUTES = new Set([30, 1440, 10080]);
const CATEGORIES = new Set(['Food and drink', 'Retail', 'Health and pharmacy', 'Services', 'Education', 'Transport', 'Other']);
const WALLETS = new Set(['Meteor Wallet', 'MyNearWallet', 'HERE Wallet', 'Intear Wallet', 'Sender']);
const REFUND_REASONS = new Set(['Customer request', 'Item unavailable', 'Order cancelled', 'Late or failed delivery', 'Duplicate payment', 'Other']);
const REPORT_REASONS = new Set([
  'I didn\u2019t receive what I paid for',
  'I was charged the wrong amount',
  'I don\u2019t recognise this business',
  'The business looked different from what I expected',
  'Something else',
]);
const CHECKOUT_ID = /^[0-9a-f]{24}$/;
const CHECKOUT_KEY = /^([0-9a-f]{24}|[A-HJ-NP-Z2-9]{6})$/;
const REFERENCE = /^[A-Z0-9-]{1,24}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const MONEY = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

type Json = Record<string, unknown>;

function hex24(): string {
  return randomBytes(12).toString('hex');
}

function code(): string {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

function receipt(): string {
  const part = () => randomBytes(2).toString('hex').toUpperCase();
  return `OB-${part()}-${part()}`;
}

function txRef(): string {
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  return Array.from({ length: 44 }, () => chars[randomInt(chars.length)]).join('');
}

function pesewas(value: string, field: string): bigint {
  const m = MONEY.exec(value.trim().replace(/,/g, ''));
  if (!m) throw appError('BAD_INPUT', field);
  const v = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  if (v <= 0n) throw appError('BAD_INPUT', field);
  return v;
}

function cedis(p: bigint): string {
  return `${p / 100n}.${(p % 100n).toString().padStart(2, '0')}`;
}

function rateMicro(rate: string): bigint {
  const [w, f = ''] = rate.split('.');
  return BigInt(w || '0') * 1_000_000n + BigInt(f.slice(0, 6).padEnd(6, '0'));
}

function usdcFor(p: bigint, rate: string): bigint {
  const r = rateMicro(rate);
  return (p * 10_000_000_000n + r - 1n) / r;
}

function clean(value: string | undefined | null, max: number): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function iso(v: unknown): string {
  return new Date(String(v)).toISOString();
}

function items(v: unknown): CheckoutItemView[] {
  return (Array.isArray(v) ? v : []).map((i: Json) => ({ name: String(i.name), qty: Number(i.qty), unit: String(i.unit) }));
}

function business(b: Json): BusinessView {
  return {
    businessId: String(b.businessId),
    name: String(b.name),
    legalName: String(b.legalName),
    category: String(b.category),
    city: String(b.city),
    supportEmail: String(b.supportEmail),
    prefix: String(b.prefix),
    verified: b.verified === true,
    ownerAccount: String(b.ownerAccount),
    since: String(b.since),
  };
}

function checkout(c: Json): CheckoutView {
  return {
    checkoutId: String(c.checkoutId),
    code: String(c.code),
    businessId: String(c.businessId),
    reference: String(c.reference),
    note: c.note == null ? null : String(c.note),
    items: items(c.items),
    amount: String(c.amount),
    rate: String(c.rate),
    usdc: String(c.usdc),
    quotedAt: iso(c.quotedAt),
    createdAt: iso(c.createdAt),
    expiresAt: iso(c.expiresAt),
    status: String(c.status),
    requested: c.requested === true,
    paymentId: c.paymentId == null ? null : String(c.paymentId),
    customer: c.customer ? { accountId: String((c.customer as Json).accountId), displayName: (c.customer as Json).displayName == null ? null : String((c.customer as Json).displayName), handle: (c.customer as Json).handle == null ? null : String((c.customer as Json).handle) } : null,
  };
}

function payment(p: Json): CheckoutPaymentView {
  return {
    paymentId: String(p.paymentId),
    receipt: String(p.receipt),
    checkoutId: String(p.checkoutId),
    businessId: String(p.businessId),
    reference: String(p.reference),
    items: items(p.items),
    amount: String(p.amount),
    rate: String(p.rate),
    usdc: String(p.usdc),
    fee: String(p.fee),
    method: String(p.method),
    wallet: p.wallet == null ? null : String(p.wallet),
    payerName: String(p.payerName),
    payerAccount: p.payerAccount == null ? null : String(p.payerAccount),
    mine: p.mine === true,
    txRef: String(p.txRef),
    createdAt: iso(p.createdAt),
    settlesAt: iso(p.settlesAt),
    refunds: (Array.isArray(p.refunds) ? p.refunds : []).map((r: Json) => ({ refundId: String(r.refundId), amount: String(r.amount), usdc: String(r.usdc), reason: String(r.reason), createdAt: iso(r.createdAt), completesAt: iso(r.completesAt) })),
    reports: (Array.isArray(p.reports) ? p.reports : []).map((r: Json) => ({ reportId: String(r.reportId), reason: String(r.reason), detail: String(r.detail), createdAt: iso(r.createdAt) })),
  };
}

function publicView(v: Json | null): PublicCheckoutView | null {
  if (!v) return null;
  return { checkout: checkout(v.checkout as Json), business: business(v.business as Json), own: v.own === true, forMe: v.forMe === true, payment: v.payment ? payment(v.payment as Json) : null };
}

function dbMessage(err: unknown): string {
  return (err as { message?: string }).message ?? '';
}

function uniqueOn(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === constraint;
}

@Resolver()
export class CommerceResolver {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly fx: FxRates,
    private readonly audit: AuditService,
  ) {}

  private async rate(): Promise<string> {
    const r = await this.fx.usdGhs();
    if (!r) throw appError('SERVICE_PAUSED', 'rate');
    return r.rate;
  }

  private async load(c: PoolClient, key: string): Promise<PublicCheckoutView | null> {
    const r = await c.query<{ v: Json | null }>('select ops.public_checkout($1) as v', [key]);
    return publicView(r.rows[0]?.v ?? null);
  }

  private async ownerOf(c: PoolClient, businessId: string): Promise<string | null> {
    const r = await c.query<{ uid: string | null }>('select ops.commerce_business_owner($1) as uid', [businessId]);
    return r.rows[0]?.uid ?? null;
  }

  @Query(() => CommerceView)
  async commerce(@Context('req') req: ObibaRequest): Promise<CommerceView> {
    const { uid } = identityOf(req);
    const r = await withUserTx(this.pool, uid, (c) => c.query<{ v: Json }>('select ops.my_commerce() as v'));
    const v = r.rows[0]!.v;
    const rate = await this.fx.usdGhs();
    return {
      business: v.business ? business(v.business as Json) : null,
      links: (v.links as Json[]).map(checkout),
      requests: (v.requests as Json[]).map(checkout),
      businessPayments: (v.businessPayments as Json[]).map(payment),
      purchases: (v.purchases as Json[]).map(payment),
      merchants: (v.merchants as Json[]).map(business),
      rate: rate?.rate ?? null,
    };
  }

  @Query(() => PublicCheckoutView, { nullable: true })
  @Public()
  @RateLimit('checkout_view')
  async publicCheckout(@Context('req') req: ObibaRequest, @Args('key') key: string): Promise<PublicCheckoutView | null> {
    const k = key.trim();
    if (!CHECKOUT_KEY.test(k) && !CHECKOUT_KEY.test(k.toUpperCase())) throw appError('BAD_INPUT', 'key');
    const run = (c: PoolClient) => this.load(c, k);
    return req.identity ? withUserTx(this.pool, req.identity.uid, run) : withTx(this.pool, run);
  }

  @Mutation(() => BusinessView)
  @RateLimit('commerce_write')
  async createBusiness(@Context('req') req: ObibaRequest, @Args('input') input: CreateBusinessInput): Promise<BusinessView> {
    const { uid } = identityOf(req);
    const name = clean(input.name, 48);
    const legal = clean(input.legalName, 80) || name;
    const city = clean(input.city, 40);
    const email = clean(input.supportEmail, 254);
    if (name.length < 2) throw appError('BAD_INPUT', 'name');
    if (city.length < 2) throw appError('BAD_INPUT', 'city');
    if (!CATEGORIES.has(input.category)) throw appError('BAD_INPUT', 'category');
    if (!EMAIL.test(email)) throw appError('BAD_INPUT', 'supportEmail');
    const words = name.split(' ').filter(Boolean);
    const prefix = (words.length > 1 ? words.slice(0, 2).map((w) => w[0]).join('') : name.slice(0, 2)).toUpperCase().replace(/[^A-Z0-9]/g, 'X').padEnd(2, 'X');
    const id = hex24();
    return withUserTx(this.pool, uid, async (c) => {
      await activeAccount(c, uid);
      try {
        await c.query('select ops.create_business($1, $2, $3, $4, $5, $6, $7)', [id, name, legal, input.category, city, email, prefix]);
      } catch (err) {
        if (dbMessage(err) === 'BUSINESS_EXISTS' || uniqueOn(err, 'businesses_owner_uid_key')) throw appError('CONFLICT', 'business');
        throw err;
      }
      await this.audit.record({ actor: uid, action: 'business.create', target: id, outcome: 'ALLOWED', requestId: req.requestId }, c);
      const v = (await c.query<{ v: Json }>('select ops.my_commerce() as v')).rows[0]!.v;
      return business(v.business as Json);
    });
  }

  @Mutation(() => CheckoutView)
  @RateLimit('commerce_write')
  async createPaymentLink(@Context('req') req: ObibaRequest, @Args('input') input: CreatePaymentLinkInput): Promise<CheckoutView> {
    const { uid } = identityOf(req);
    const amount = pesewas(input.amount, 'amount');
    if (amount > MAX_AMOUNT) throw appError('BAD_INPUT', 'amount');
    const reference = clean(input.reference, 24).toUpperCase();
    if (!REFERENCE.test(reference)) throw appError('BAD_INPUT', 'reference');
    if (!EXPIRY_MINUTES.has(input.expiresInMinutes)) throw appError('BAD_INPUT', 'expiresInMinutes');
    const note = clean(input.note, 80) || null;
    const rate = await this.rate();
    const usdc = usdcFor(amount, rate);
    const lineItems = JSON.stringify([{ name: note ?? reference, qty: 1, unit: cedis(amount) }]);
    const expires = new Date(Date.now() + input.expiresInMinutes * 60_000).toISOString();
    const customerAccount = clean(input.customerAccount, 64) || null;
    return withUserTx(this.pool, uid, async (c) => {
      let customerUid: string | null = null;
      if (customerAccount) {
        customerUid = (await c.query<{ uid: string }>('select uid from ops.invoice_payer($1)', [customerAccount])).rows[0]?.uid ?? null;
        if (!customerUid || customerUid === uid) throw appError('BAD_INPUT', 'customerAccount');
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const id = hex24();
        await c.query('savepoint link');
        try {
          await c.query('select ops.create_checkout($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)', [id, code(), reference, note, lineItems, cedis(amount), rate, usdc.toString(), expires, customerUid]);
        } catch (err) {
          await c.query('rollback to savepoint link');
          if (uniqueOn(err, 'checkouts_code_key')) continue;
          if (dbMessage(err) === 'CHECKOUT_REFERENCE_TAKEN' || uniqueOn(err, 'checkouts_open_reference')) throw appError('CONFLICT', 'reference');
          if (dbMessage(err) === 'BUSINESS_MISSING') throw appError('FORBIDDEN', 'business');
          if (dbMessage(err) === 'CHECKOUT_CUSTOMER_INVALID') throw appError('BAD_INPUT', 'customerAccount');
          throw err;
        }
        await this.audit.record({ actor: uid, action: 'checkout.create', target: id, outcome: 'ALLOWED', requestId: req.requestId }, c);
        const view = await this.load(c, id);
        return view!.checkout;
      }
      throw appError('CONFLICT', 'code');
    });
  }

  @Mutation(() => String)
  @RateLimit('commerce_write')
  async cancelPaymentLink(@Context('req') req: ObibaRequest, @Args('checkoutId') checkoutId: string): Promise<string> {
    return this.close(req, checkoutId, 'CANCEL');
  }

  @Mutation(() => String)
  @RateLimit('commerce_write')
  async declineCheckout(@Context('req') req: ObibaRequest, @Args('checkoutId') checkoutId: string): Promise<string> {
    return this.close(req, checkoutId, 'DECLINE');
  }

  private async close(req: ObibaRequest, checkoutId: string, action: 'CANCEL' | 'DECLINE'): Promise<string> {
    const { uid } = identityOf(req);
    if (!CHECKOUT_ID.test(checkoutId)) throw appError('BAD_INPUT', 'checkoutId');
    return withUserTx(this.pool, uid, async (c) => {
      let status: string | null;
      try {
        status = (await c.query<{ s: string | null }>('select ops.close_checkout($1, $2) as s', [checkoutId, action])).rows[0]?.s ?? null;
      } catch (err) {
        if (dbMessage(err) === 'CHECKOUT_NOT_FOUND') throw appError('NOT_FOUND', 'checkoutId');
        throw err;
      }
      if (!status) throw appError('CONFLICT', 'checkoutId');
      await this.audit.record({ actor: uid, action: `checkout.${action.toLowerCase()}`, target: checkoutId, outcome: 'ALLOWED', requestId: req.requestId }, c);
      return status;
    });
  }

  @Mutation(() => PublicCheckoutView, { nullable: true })
  @Public()
  @RateLimit('checkout_view')
  async requoteCheckout(@Context('req') req: ObibaRequest, @Args('checkoutId') checkoutId: string): Promise<PublicCheckoutView | null> {
    if (!CHECKOUT_ID.test(checkoutId)) throw appError('BAD_INPUT', 'checkoutId');
    const rate = await this.rate();
    const run = async (c: PoolClient) => {
      const current = await this.load(c, checkoutId);
      if (!current) return null;
      const usdc = usdcFor(pesewas(current.checkout.amount, 'amount'), rate);
      await c.query('select ops.requote_checkout($1, $2, $3)', [checkoutId, rate, usdc.toString()]);
      return this.load(c, checkoutId);
    };
    return req.identity ? withUserTx(this.pool, req.identity.uid, run) : withTx(this.pool, run);
  }

  @Mutation(() => CheckoutPayResult)
  @RateLimit('checkout_pay')
  async payCheckout(@Context('req') req: ObibaRequest, @Args('checkoutId') checkoutId: string): Promise<CheckoutPayResult> {
    const { uid } = identityOf(req);
    if (!CHECKOUT_ID.test(checkoutId)) throw appError('BAD_INPUT', 'checkoutId');
    const done = await withUserTx(this.pool, uid, async (c) => {
      const account = await activeAccount(c, uid);
      const view = await this.load(c, checkoutId);
      if (!view) return { status: 'NOT_FOUND', payment: null, owner: null };
      const bal = (await c.query<{ available: string }>("select available from ledger.my_balances() where domain = 'REAL' and currency = 'USDC'")).rows[0];
      if (view.checkout.status === 'OPEN' && !view.own && BigInt(bal?.available ?? '0') < BigInt(view.checkout.usdc)) return { status: 'INSUFFICIENT_FUNDS', payment: null, owner: null };
      const name = (await c.query<{ display_name: string | null }>('select display_name from identity.users where uid = $1', [uid])).rows[0]?.display_name ?? account;
      return this.pay(c, req, uid, checkoutId, 'OBIBA', null, name, account);
    });
    if (done.owner && done.payment) await publishUserEvents(this.redis, [{ uid: done.owner, kind: 'invoice', id: done.payment.paymentId, status: 'PAID' }]);
    return { status: done.status, payment: done.payment };
  }

  @Mutation(() => CheckoutPayResult)
  @Public()
  @RateLimit('checkout_pay')
  async payCheckoutWithWallet(@Context('req') req: ObibaRequest, @Args('checkoutId') checkoutId: string, @Args('wallet') wallet: string): Promise<CheckoutPayResult> {
    if (!CHECKOUT_ID.test(checkoutId)) throw appError('BAD_INPUT', 'checkoutId');
    if (!WALLETS.has(wallet)) throw appError('BAD_INPUT', 'wallet');
    const run = (c: PoolClient) => this.pay(c, req, req.identity?.uid ?? null, checkoutId, 'NEAR_WALLET', wallet, 'NEAR wallet', null);
    const done = req.identity ? await withUserTx(this.pool, req.identity.uid, run) : await withTx(this.pool, run);
    if (done.owner && done.payment) await publishUserEvents(this.redis, [{ uid: done.owner, kind: 'invoice', id: done.payment.paymentId, status: 'PAID' }]);
    return { status: done.status, payment: done.payment };
  }

  private async pay(c: PoolClient, req: ObibaRequest, uid: string | null, checkoutId: string, method: 'OBIBA' | 'NEAR_WALLET', wallet: string | null, payerName: string, payerAccount: string | null) {
    const paymentId = hex24();
    const status = (
      await c.query<{ s: string }>('select ops.pay_checkout($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as s', [
        checkoutId,
        paymentId,
        receipt(),
        method,
        wallet,
        payerName.slice(0, 80),
        payerAccount,
        txRef(),
        FEE_BPS,
        QUOTE_SECONDS,
        SETTLE_SECONDS,
      ])
    ).rows[0]!.s;
    await this.audit.record({ actor: uid ?? 'public', action: 'checkout.pay', target: checkoutId, outcome: status === 'OK' ? 'ALLOWED' : 'DENIED', requestId: req.requestId, details: { status, method } }, c);
    if (status !== 'OK') return { status, payment: null, owner: null };
    const view = await this.load(c, checkoutId);
    const owner = view ? await this.ownerOf(c, view.checkout.businessId) : null;
    const paid = view?.payment ?? (await this.paymentById(c, paymentId));
    return { status: 'SUCCEEDED', payment: paid, owner };
  }

  private async paymentById(c: PoolClient, paymentId: string): Promise<CheckoutPaymentView | null> {
    const r = await c.query<{ v: Json | null }>('select ops.commerce_payment($1) as v', [paymentId]);
    return r.rows[0]?.v ? payment(r.rows[0].v) : null;
  }

  @Mutation(() => CheckoutPayResult)
  @RateLimit('commerce_write')
  async refundCheckoutPayment(
    @Context('req') req: ObibaRequest,
    @Args('paymentId') paymentId: string,
    @Args('amount') amount: string,
    @Args('reason') reason: string,
  ): Promise<CheckoutPayResult> {
    const { uid } = identityOf(req);
    if (!CHECKOUT_ID.test(paymentId)) throw appError('BAD_INPUT', 'paymentId');
    if (!REFUND_REASONS.has(reason)) throw appError('BAD_INPUT', 'reason');
    const value = pesewas(amount, 'amount');
    return withUserTx(this.pool, uid, async (c) => {
      const status = (await c.query<{ s: string }>('select ops.refund_checkout_payment($1, $2, $3, $4, $5) as s', [hex24(), paymentId, cedis(value), reason, REFUND_SECONDS])).rows[0]!.s;
      await this.audit.record({ actor: uid, action: 'checkout.refund', target: paymentId, outcome: status === 'OK' ? 'ALLOWED' : 'DENIED', requestId: req.requestId, details: { status, amount: cedis(value) } }, c);
      if (status !== 'OK') return { status, payment: null };
      return { status: 'REFUNDED', payment: await this.paymentById(c, paymentId) };
    });
  }

  @Mutation(() => String)
  @RateLimit('commerce_write')
  async reportCheckoutPayment(@Context('req') req: ObibaRequest, @Args('paymentId') paymentId: string, @Args('reason') reason: string, @Args('detail') detail: string): Promise<string> {
    const { uid } = identityOf(req);
    if (!CHECKOUT_ID.test(paymentId)) throw appError('BAD_INPUT', 'paymentId');
    if (!REPORT_REASONS.has(reason)) throw appError('BAD_INPUT', 'reason');
    const id = `CS-${randomBytes(3).toString('hex').toUpperCase()}`;
    const ok = await withUserTx(this.pool, uid, async (c) => (await c.query<{ ok: boolean }>('select ops.report_checkout_payment($1, $2, $3, $4) as ok', [id, paymentId, reason, clean(detail, 600)])).rows[0]?.ok === true);
    if (!ok) throw appError('NOT_FOUND', 'paymentId');
    return id;
  }

}
