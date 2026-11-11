import { Inject } from '@nestjs/common';
import { Args, Context, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { Pool, PoolClient } from 'pg';
import type Redis from 'ioredis';
import { withUserTx } from '@obiba/db';
import { emailJob, enqueueEmail, isHexId, newHexId, publishUserEvents, UNCAPPED_USD, USDC_DECIMALS, type MoneyRequestFacts } from '@obiba/domain';
import { appError } from '../errors';
import { CreateMoneyRequestInput, MoneyRequestView, RequestContactView } from '../graphql/types';
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
  permission: string;
}

interface FactsRow {
  requester_uid: string;
  payer_uid: string;
  requester_name: string;
  requester_handle: string | null;
  payer_name: string;
  payer_handle: string | null;
  amount: string;
  note: string | null;
  permission: string;
}

const DECISIONS = new Set(['ALLOW', 'ALLOW_ONCE', 'BLOCK']);
const CONTACT_ID = /^[pb][1-9]\d{0,17}$/;

const LURE = /(https?:|www\.|\.(com|net|org|io|gh|me|ly|xyz|app)\b|@[a-z0-9-]+\.|(?:\+?233|0)[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}|\d{9,})/i;

const LIMITS: Record<string, [Parameters<typeof appError>[0], string]> = {
  REQUEST_PENDING: ['CONFLICT', 'toHandle'],
  REQUEST_BLOCKED: ['FORBIDDEN', 'toHandle'],
  REQUEST_COOLDOWN: ['FORBIDDEN', 'toHandle'],
  REQUEST_RESTRICTED: ['FORBIDDEN', 'toHandle'],
  REQUEST_ASK_LIMIT: ['RATE_LIMITED', 'toHandle'],
  REQUEST_LIMIT: ['RATE_LIMITED', 'amount'],
};

const RESPONSES: Record<string, [Parameters<typeof appError>[0], string]> = {
  REQUEST_NOT_FOUND: ['NOT_FOUND', 'requestId'],
  REQUEST_CLOSED: ['CONFLICT', 'requestId'],
  REQUEST_NOT_ASKING: ['CONFLICT', 'requestId'],
  REQUEST_PAYING: ['CONFLICT', 'requestId'],
};

function dbMessage(err: unknown): string {
  return (err as { message?: string }).message ?? '';
}

export async function requestFacts(c: PoolClient, requestId: string, side: 'requester' | 'payer'): Promise<{ to: string; facts: MoneyRequestFacts } | null> {
  const f = (await c.query<FactsRow>('select * from ops.money_request_email_facts($1)', [requestId])).rows[0];
  if (!f) return null;
  const fromRequester = side === 'requester';
  return {
    to: fromRequester ? f.payer_uid : f.requester_uid,
    facts: {
      requestId,
      name: fromRequester ? f.requester_name : f.payer_name,
      handle: fromRequester ? f.requester_handle : f.payer_handle,
      units: f.amount,
      decimals: USDC_DECIMALS,
      currency: 'USDC',
      note: f.note,
      firstTime: fromRequester && f.permission === 'ASKING',
      at: new Date().toISOString(),
    },
  };
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
    permission: r.permission,
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
  @RateLimit('money_request')
  @KillSwitch('transfers')
  async createMoneyRequest(@Context('req') req: ObibaRequest, @Args('input') input: CreateMoneyRequestInput): Promise<MoneyRequestView> {
    const { uid } = identityOf(req);
    const query = classifyRecipient(`@${String(input.toHandle).trim().replace(/^@/, '')}`);
    if (query.by !== 'handle') throw appError('BAD_INPUT', 'toHandle');
    const units = amount(input.amount, USDC_DECIMALS, UNCAPPED_USD);
    const note = input.note == null || input.note.trim() === '' ? null : parse(reference, input.note.trim().replace(/\s+/g, ' '), 'note');
    if (note !== null && LURE.test(note)) throw appError('BAD_INPUT', 'note');
    const requestId = newHexId();
    const created = await withUserTx(this.pool, uid, async (c) => {
      await activeAccount(c, uid);
      const payer = (await c.query<{ uid: string }>('select uid from ops.request_payer($1)', [query.value])).rows[0];
      if (!payer) throw appError('NOT_FOUND', 'toHandle');
      if (payer.uid === uid) throw appError('BAD_INPUT', 'toHandle');
      await c.query('savepoint create_request');
      try {
        await c.query('select ops.create_money_request($1, $2, $3, $4)', [requestId, payer.uid, units.toString(), note]);
      } catch (err) {
        const hit = (err as { code?: string }).code === '23505' ? LIMITS.REQUEST_PENDING : LIMITS[dbMessage(err)];
        if (!hit) throw err;
        await c.query('rollback to savepoint create_request');
        await this.audit.record({ actor: uid, action: 'money_request.create', target: requestId, outcome: 'DENIED', requestId: req.requestId, details: { reason: (err as Error).message } }, c);
        throw appError(hit[0], hit[1]);
      }
      const mail = await requestFacts(c, requestId, 'requester');
      if (mail) await enqueueEmail(c, emailJob('MONEY_REQUESTED', { uid: mail.to }, `money-request:${requestId}:requested`, mail.facts));
      await this.audit.record({ actor: uid, action: 'money_request.create', target: requestId, outcome: 'ALLOWED', requestId: req.requestId }, c);
      const row = (await c.query<RequestRow>('select * from ops.my_money_requests(100) where request_id = $1', [requestId])).rows[0];
      return { row: row!, payer: payer.uid };
    });
    await publishUserEvents(this.redis, [{ uid: created.payer, kind: 'invoice', id: requestId, status: 'REQUESTED' }]);
    return view(created.row);
  }

  @Mutation(() => MoneyRequestView)
  @RateLimit('quote')
  async respondToMoneyRequest(@Context('req') req: ObibaRequest, @Args('requestId') requestId: string, @Args('decision') decision: string): Promise<MoneyRequestView> {
    const { uid } = identityOf(req);
    if (!isHexId(requestId)) throw appError('BAD_INPUT', 'requestId');
    if (!DECISIONS.has(decision)) throw appError('BAD_INPUT', 'decision');
    const done = await withUserTx(this.pool, uid, async (c) => {
      try {
        await c.query('select ops.respond_money_request($1, $2)', [requestId, decision]);
      } catch (err) {
        const hit = RESPONSES[dbMessage(err)];
        if (!hit) throw err;
        throw appError(hit[0], hit[1]);
      }
      const facts = (await c.query<{ requester_uid: string }>('select requester_uid from ops.money_request_email_facts($1)', [requestId])).rows[0];
      const row = (await c.query<RequestRow>('select * from ops.my_money_requests(100) where request_id = $1', [requestId])).rows[0];
      return { row: row!, requester: facts?.requester_uid ?? null };
    });
    if (done.requester && decision !== 'BLOCK') await publishUserEvents(this.redis, [{ uid: done.requester, kind: 'invoice', id: requestId, status: done.row.permission }]);
    return view(done.row);
  }

  @Query(() => [RequestContactView])
  async requestContacts(@Context('req') req: ObibaRequest): Promise<RequestContactView[]> {
    const { uid } = identityOf(req);
    const r = await withUserTx(this.pool, uid, (c) =>
      c.query<{ id: string; kind: string; name: string; handle: string | null; since: Date }>('select * from ops.my_request_contacts()'),
    );
    return r.rows.map((x) => ({ id: x.id, kind: x.kind, name: x.name, handle: x.handle, since: new Date(x.since).toISOString() }));
  }

  @Mutation(() => Boolean)
  @RateLimit('quote')
  async revokeRequestPermission(@Context('req') req: ObibaRequest, @Args('id') id: string): Promise<boolean> {
    return this.contactAction(req, id, 'p', 'select ops.revoke_request_permission($1) as ok');
  }

  @Mutation(() => Boolean)
  @RateLimit('quote')
  async unblockRequester(@Context('req') req: ObibaRequest, @Args('id') id: string): Promise<boolean> {
    return this.contactAction(req, id, 'b', 'select ops.unblock_requester($1) as ok');
  }

  private async contactAction(req: ObibaRequest, id: string, prefix: 'p' | 'b', sql: string): Promise<boolean> {
    const { uid } = identityOf(req);
    if (!CONTACT_ID.test(id) || id[0] !== prefix) throw appError('BAD_INPUT', 'id');
    const ok = await withUserTx(this.pool, uid, async (c) => (await c.query<{ ok: boolean }>(sql, [id.slice(1)])).rows[0]?.ok === true);
    if (!ok) throw appError('NOT_FOUND', 'id');
    return true;
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
      if (action === 'DECLINE') {
        const mail = await requestFacts(c, requestId, 'payer');
        if (mail) await enqueueEmail(c, emailJob('MONEY_REQUEST_DECLINED', { uid: mail.to }, `money-request:${requestId}:declined`, mail.facts));
      }
      return r;
    });
    await publishUserEvents(this.redis, [{ uid: done.notify_uid, kind: 'invoice', id: requestId, status: done.status }]);
    return done.status;
  }
}
