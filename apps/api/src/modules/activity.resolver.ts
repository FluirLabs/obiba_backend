import { Inject } from '@nestjs/common';
import { Args, Context, Field, ID, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';
import type { Pool } from 'pg';
import { withUserTx } from '@obiba/db';
import { isHexId } from '@obiba/domain';
import { APP_CONFIG, explorerTxUrl, type AppConfig } from '../config';
import { appError } from '../errors';
import { ActivityItem, OpView, PendingItem } from '../graphql/types';
import { QUOTE_SOURCE } from './quotes';
import { SANDBOX_NOTICE } from '@obiba/domain';
import { PG_POOL } from '../infra/tokens';
import { identityOf, type ObibaRequest } from '../security/request';

@ObjectType()
export class TransactionView {
  @Field(() => ID) id!: string;
  @Field() type!: string;
  @Field() domain!: string;
  @Field() status!: string;
  @Field() amount!: string;
  @Field() asset!: string;
  @Field(() => String, { nullable: true }) fee!: string | null;
  @Field(() => String, { nullable: true }) sourceNetwork!: string | null;
  @Field(() => String, { nullable: true }) destinationNetwork!: string | null;
  @Field(() => String, { nullable: true }) recipient!: string | null;
  @Field() createdAt!: string;
  @Field(() => String, { nullable: true }) quoteSource!: string | null;
  @Field(() => [String]) references!: string[];
  @Field(() => [String]) explorerUrls!: string[];
  @Field(() => String, { nullable: true }) notice!: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PENDING_OPS = ['COSIGNED', 'SUBMITTED', 'RELAYED', 'UNKNOWN'];
const PENDING_DEPOSITS = ['AWAITING_DEPOSIT', 'DETECTED', 'CONVERTING', 'INCOMPLETE', 'REFUND_PENDING', 'VERIFYING_SETTLEMENT', 'REVIEW_REQUIRED'];
const PENDING_WITHDRAWALS = ['SUBMITTED', 'SENT', 'PROCESSING', 'VERIFYING', 'REVIEW_REQUIRED'];

@Resolver()
export class ActivityResolver {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Query(() => [ActivityItem])
  async activity(
    @Context('req') req: ObibaRequest,
    @Args('first', { type: () => Int, defaultValue: 20 }) first: number,
    @Args('before', { type: () => String, nullable: true }) before: string | null,
  ): Promise<ActivityItem[]> {
    const { uid } = identityOf(req);
    if (!Number.isInteger(first) || first < 1 || first > 100) throw appError('BAD_INPUT', 'first');
    if (before != null && !/^[1-9]\d{0,17}$/.test(before)) throw appError('BAD_INPUT', 'before');
    const r = await withUserTx(this.pool, uid, (c) => c.query('select * from ledger.my_activity_detail($1, $2)', [first, before ?? null]));
    return r.rows.map((a) => {
      const real = a.domain === 'REAL';
      return {
        id: String(a.journal_id),
        domain: a.domain,
        kind: a.kind,
        direction: a.amount.startsWith('-') ? 'OUT' : 'IN',
        status: 'POSTED',
        amount: a.amount.replace(/^-/, ''),
        currency: a.currency,
        createdAt: new Date(a.created_at).toISOString(),
        counterparty: real ? a.counterparty : null,
        counterpartyName: real ? a.counterparty_name : null,
        opId: real ? a.op_id : null,
        txHash: real ? a.tx_hash : null,
        explorerUrl: real ? explorerTxUrl(this.config, a.tx_hash) : null,
        sandboxId: real ? null : a.sandbox_id,
      };
    });
  }

  @Query(() => [PendingItem])
  async pendingActivity(@Context('req') req: ObibaRequest): Promise<PendingItem[]> {
    const { uid } = identityOf(req);
    const r = await withUserTx(this.pool, uid, (c) =>
      c.query<{ id: string; kind: string; status: string; amount: string; counterparty: string | null; created_at: Date }>(
        `select * from (
           select op_id as id, case when kind = 'PayInvoice' then 'INVOICE_PAYMENT' else 'TRANSFER' end as kind, status,
                  amount::text, receiver as counterparty, created_at
             from ops.prepared_ops p
            where status = any($1) and not exists (select 1 from ops.withdrawals w where w.op_id = p.op_id)
           union all
           select id::text, 'DEPOSIT', status, min_amount_out::text, origin_asset, created_at
             from ops.deposits where status = any($2)
           union all
           select id::text, 'WITHDRAWAL', status, amount_in::text, recipient, created_at
             from ops.withdrawals where status = any($3)
         ) x order by created_at desc limit 50`,
        [PENDING_OPS, PENDING_DEPOSITS, PENDING_WITHDRAWALS],
      ),
    );
    return r.rows.map((p) => ({
      id: p.id,
      kind: p.kind,
      status: p.status,
      amount: p.amount,
      currency: 'USDC',
      counterparty: p.counterparty,
      createdAt: new Date(p.created_at).toISOString(),
    }));
  }

  @Query(() => OpView, { nullable: true })
  async op(@Context('req') req: ObibaRequest, @Args('opId') opId: string): Promise<OpView | null> {
    const { uid } = identityOf(req);
    if (!isHexId(opId)) throw appError('BAD_INPUT', 'opId');
    const r = await withUserTx(this.pool, uid, (c) =>
      c.query<{ op_id: string; kind: string; status: string; receiver: string; amount: string; invoice_id: string | null; relay_tx_hashes: string[]; created_at: Date; updated_at: Date }>(
        'select op_id, kind, status, receiver, amount::text, invoice_id, relay_tx_hashes, created_at, updated_at from ops.prepared_ops where op_id = $1',
        [opId],
      ),
    );
    const o = r.rows[0];
    if (!o) return null;
    return {
      opId: o.op_id,
      kind: o.kind,
      status: o.status,
      receiver: o.receiver,
      amount: o.amount,
      invoiceId: o.invoice_id,
      txHashes: o.relay_tx_hashes,
      explorerUrls: o.relay_tx_hashes.map((h) => explorerTxUrl(this.config, h)).filter((u): u is string => u !== null),
      createdAt: new Date(o.created_at).toISOString(),
      updatedAt: new Date(o.updated_at).toISOString(),
    };
  }

  @Query(() => TransactionView, { nullable: true })
  async transaction(@Context('req') req: ObibaRequest, @Args('id') id: string): Promise<TransactionView | null> {
    const { uid } = identityOf(req);
    const explorer = (hashes: Array<string | null | undefined>) =>
      hashes.map((h) => explorerTxUrl(this.config, h ?? null)).filter((u): u is string => u !== null);
    return withUserTx(this.pool, uid, async (c) => {
      if (isHexId(id)) {
        const r = await c.query<{ kind: string; status: string; receiver: string; amount: string; relay_tx_hashes: string[]; created_at: Date }>(
          'select kind, status, receiver, amount::text, relay_tx_hashes, created_at from ops.prepared_ops where op_id = $1',
          [id],
        );
        const o = r.rows[0];
        if (!o) return null;
        const w = await c.query<{ destination: string; recipient: string }>('select destination, recipient from ops.withdrawals where op_id = $1', [id]);
        return {
          id,
          type: w.rows[0] ? 'WITHDRAWAL' : o.kind === 'PayInvoice' ? 'INVOICE_PAYMENT' : 'TRANSFER',
          domain: 'REAL',
          status: o.status,
          amount: o.amount,
          asset: 'USDC',
          fee: w.rows[0] ? null : '0',
          sourceNetwork: 'NEAR',
          destinationNetwork: w.rows[0]?.destination ?? 'NEAR',
          recipient: w.rows[0]?.recipient ?? o.receiver,
          createdAt: new Date(o.created_at).toISOString(),
          quoteSource: w.rows[0] ? QUOTE_SOURCE : null,
          references: o.relay_tx_hashes,
          explorerUrls: explorer(o.relay_tx_hashes),
          notice: null,
        };
      }
      if (UUID.test(id)) {
        const d = await c.query<{ origin_asset: string; status: string; min_amount_out: string; account_id: string; created_at: Date; tx_hashes: { origin?: string[]; near?: string[] } }>(
          'select origin_asset, status, min_amount_out::text, account_id, created_at, tx_hashes from ops.deposits where id = $1',
          [id],
        );
        if (d.rows[0]) {
          const x = d.rows[0];
          const near = x.tx_hashes?.near ?? [];
          return {
            id,
            type: 'DEPOSIT',
            domain: 'REAL',
            status: x.status,
            amount: x.min_amount_out,
            asset: 'USDC',
            fee: null,
            sourceNetwork: x.origin_asset,
            destinationNetwork: 'NEAR',
            recipient: x.account_id,
            createdAt: new Date(x.created_at).toISOString(),
            quoteSource: QUOTE_SOURCE,
            references: [...(x.tx_hashes?.origin ?? []), ...near],
            explorerUrls: explorer(near),
            notice: null,
          };
        }
        const w = await c.query<{ destination: string; recipient: string; status: string; amount_in: string; created_at: Date; tx_hashes: { near?: string; destination?: string[] } }>(
          'select destination, recipient, status, amount_in::text, created_at, tx_hashes from ops.withdrawals where id = $1',
          [id],
        );
        if (w.rows[0]) {
          const x = w.rows[0];
          return {
            id,
            type: 'WITHDRAWAL',
            domain: 'REAL',
            status: x.status,
            amount: x.amount_in,
            asset: 'USDC',
            fee: null,
            sourceNetwork: 'NEAR',
            destinationNetwork: x.destination,
            recipient: x.recipient,
            createdAt: new Date(x.created_at).toISOString(),
            quoteSource: QUOTE_SOURCE,
            references: [x.tx_hashes?.near, ...(x.tx_hashes?.destination ?? [])].filter((h): h is string => typeof h === 'string'),
            explorerUrls: explorer([x.tx_hashes?.near]),
            notice: null,
          };
        }
        const sb = await c.query<{ kind: string; provider: string; target: string; amount: string; status: string; created_at: Date; quote: { fee?: string } | null }>(
          'select kind, provider, target, amount::text, status, created_at, quote from ops.sandbox_ops where id = $1',
          [id],
        );
        if (sb.rows[0]) {
          const x = sb.rows[0];
          return {
            id,
            type: `SANDBOX_${x.kind}`,
            domain: 'DEMO',
            status: x.status,
            amount: x.amount,
            asset: 'DEMO_USDC',
            fee: x.quote?.fee ?? null,
            sourceNetwork: null,
            destinationNetwork: x.provider,
            recipient: x.target,
            createdAt: new Date(x.created_at).toISOString(),
            quoteSource: 'Sandbox simulation',
            references: [id],
            explorerUrls: [],
            notice: SANDBOX_NOTICE,
          };
        }
        return null;
      }
      if (/^[1-9]\d{0,17}$/.test(id)) {
        const r = await c.query('select * from ledger.my_activity_detail($1, $2)', [1, (BigInt(id) + 1n).toString()]);
        const a = r.rows[0];
        if (!a || String(a.journal_id) !== id) return null;
        const real = a.domain === 'REAL';
        return {
          id,
          type: a.kind.toUpperCase(),
          domain: a.domain,
          status: 'POSTED',
          amount: a.amount.replace(/^-/, ''),
          asset: a.currency,
          fee: null,
          sourceNetwork: real ? 'NEAR' : null,
          destinationNetwork: real ? 'NEAR' : null,
          recipient: real ? a.counterparty : null,
          createdAt: new Date(a.created_at).toISOString(),
          quoteSource: null,
          references: real && a.tx_hash ? [a.tx_hash] : [],
          explorerUrls: real ? explorer([a.tx_hash]) : [],
          notice: real ? null : SANDBOX_NOTICE,
        };
      }
      throw appError('BAD_INPUT', 'id');
    });
  }
}
