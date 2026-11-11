import { Inject } from '@nestjs/common';
import { Args, Context, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { withUserTx } from '@obiba/db';
import { isHexId, newHexId, publishUserEvents, UNCAPPED_USD, USDC_DECIMALS } from '@obiba/domain';
import { appError } from '../errors';
import { CreateMoneyRequestInput, MoneyRequestView } from '../graphql/types';
import { AuditService } from '../infra/audit';
import { PG_POOL, REDIS } from '../infra/tokens';
import { KillSwitch } from '../security/kill-switch';
import { RateLimit } from '../security/decorators';
import { identityOf, type ObibaRequest } from '../security/request';
import { activeAccount } from './payments.resolver';
import { classifyRecipient } from './recipients';
import { amount, parse, reference } from './validation';

interface RequestRow {
  request_id: string;
  direction: string;
  counterparty_name: string;
  counterparty_handle: string | null;
  counterparty_account: string | null;
  amount: string;
  note: string | null;
  status: string;
  paying: boolean;
  created_at: Date;
  updated_at: Date;
}

function view(r: RequestRow): MoneyRequestView {
  return {
    requestId: r.request_id,
    direction: r.direction,
    counterpartyName: r.counterparty_name,
    counterpartyHandle: r.counterparty_handle,
    counterpartyAccount: r.counterparty_account,
    amount: r.amount,
    note: r.note,
    status: r.status,
    paying: r.paying,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

@Resolver()
export class MoneyRequestsResolver {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly audit: AuditService,
  ) {}

  @Query(() => [MoneyRequestView])
  async moneyRequests(@Context('req') req: ObibaRequest, @Args('first', { type: () => Int, defaultValue: 50 }) first: number): Promise<MoneyRequestView[]> {
    const { uid } = identityOf(req);
    if (!Number.isInteger(first) || first < 1 || first > 100) throw appError('BAD_INPUT', 'first');
    const r = await withUserTx(this.pool, uid, (c) => c.query<RequestRow>('select * from ops.my_money_requests($1)', [first]));
    return r.rows.map(view);
  }

  @Mutation(() => MoneyRequestView)
  @RateLimit('invoice_create')
  @KillSwitch('transfers')
  async createMoneyRequest(@Context('req') req: ObibaRequest, @Args('input') input: CreateMoneyRequestInput): Promise<MoneyRequestView> {
    const { uid } = identityOf(req);
    const query = classifyRecipient(`@${String(input.toHandle).trim().replace(/^@/, '')}`);
    if (query.by !== 'handle') throw appError('BAD_INPUT', 'toHandle');
    const units = amount(input.amount, USDC_DECIMALS, UNCAPPED_USD);
    const note = input.note == null || input.note.trim() === '' ? null : parse(reference, input.note.trim().replace(/\s+/g, ' '), 'note');
    const requestId = newHexId();
    const created = await withUserTx(this.pool, uid, async (c) => {
      await activeAccount(c, uid);
      const payer = (await c.query<{ uid: string }>('select uid from ops.request_payer($1)', [query.value])).rows[0];
      if (!payer) throw appError('NOT_FOUND', 'toHandle');
      if (payer.uid === uid) throw appError('BAD_INPUT', 'toHandle');
      await c.query('select ops.create_money_request($1, $2, $3, $4)', [requestId, payer.uid, units.toString(), note]);
      await this.audit.record({ actor: uid, action: 'money_request.create', target: requestId, outcome: 'ALLOWED', requestId: req.requestId }, c);
      const row = (await c.query<RequestRow>('select * from ops.my_money_requests(100) where request_id = $1', [requestId])).rows[0];
      return { row: row!, payer: payer.uid };
    });
    await publishUserEvents(this.redis, [{ uid: created.payer, kind: 'invoice', id: requestId, status: 'REQUESTED' }]);
    return view(created.row);
  }

  @Mutation(() => String)
  @RateLimit('quote')
  async declineMoneyRequest(@Context('req') req: ObibaRequest, @Args('requestId') requestId: string): Promise<string> {
    return this.close(req, requestId, 'DECLINE');
  }

  @Mutation(() => String)
  @RateLimit('quote')
  async cancelMoneyRequest(@Context('req') req: ObibaRequest, @Args('requestId') requestId: string): Promise<string> {
    return this.close(req, requestId, 'CANCEL');
  }

  private async close(req: ObibaRequest, requestId: string, action: 'DECLINE' | 'CANCEL'): Promise<string> {
    const { uid } = identityOf(req);
    if (!isHexId(requestId)) throw appError('BAD_INPUT', 'requestId');
    const done = await withUserTx(this.pool, uid, async (c) => {
      const r = (await c.query<{ status: string; notify_uid: string }>('select * from ops.close_money_request($1, $2)', [requestId, action])).rows[0];
      if (!r) throw appError('CONFLICT', 'requestId');
      await this.audit.record({ actor: uid, action: `money_request.${action.toLowerCase()}`, target: requestId, outcome: 'ALLOWED', requestId: req.requestId }, c);
      return r;
    });
    await publishUserEvents(this.redis, [{ uid: done.notify_uid, kind: 'invoice', id: requestId, status: done.status }]);
    return done.status;
  }
}
