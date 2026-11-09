import { createHash, randomBytes } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { Args, Context, Field, ID, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import type { Pool, PoolClient } from 'pg';
import { withUserTx } from '@obiba/db';
import { SUPPORT_OPEN_STATES, ed25519KeyBytes, normalizeGhanaPhone, supportEarliestAt } from '@obiba/domain';
import { appError } from '../errors';
import { AuditService } from '../infra/audit';
import { notifyUser } from '../infra/notify';
import { PG_POOL } from '../infra/tokens';
import { Public, RateLimit, RequireFreshSession } from '../security/decorators';
import { identityOf, type ObibaRequest } from '../security/request';

@ObjectType()
export class SupportCaseView {
  @Field(() => ID) caseId!: string;
  @Field() status!: string;
  @Field() newPublicKey!: string;
  @Field() createdAt!: string;
  @Field() earliestAt!: string;
  @Field(() => String, { nullable: true }) closedReason!: string | null;
}

@ObjectType()
export class SupportLinkView {
  @Field() uid!: string;
  @Field() firstName!: string;
  @Field() expiresAt!: string;
}

@ObjectType()
export class SupportRequestReceipt {
  @Field(() => ID) caseId!: string;
  @Field() statusToken!: string;
  @Field() earliestAt!: string;
}

@ObjectType()
export class SupportRequestStatus {
  @Field() status!: string;
  @Field() earliestAt!: string;
  @Field(() => String, { nullable: true }) closedReason!: string | null;
  @Field(() => String, { nullable: true }) recoveryStatus!: string | null;
  @Field(() => String, { nullable: true }) movesAt!: string | null;
  @Field() activated!: boolean;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}$/;

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

interface CaseRow {
  id: string;
  status: string;
  new_public_key: string;
  created_at: Date;
  closed_reason: string | null;
}

const COLUMNS = 'id, status, new_public_key, created_at, closed_reason';

function toView(r: CaseRow): SupportCaseView {
  const created = new Date(r.created_at);
  return {
    caseId: r.id,
    status: r.status,
    newPublicKey: r.new_public_key,
    createdAt: created.toISOString(),
    earliestAt: supportEarliestAt(created).toISOString(),
    closedReason: r.status === 'REJECTED' ? r.closed_reason : null,
  };
}

async function latest(c: PoolClient): Promise<CaseRow | null> {
  const r = await c.query<CaseRow>(`select ${COLUMNS} from ops.support_cases order by created_at desc limit 1`);
  return r.rows[0] ?? null;
}

@Resolver()
export class SupportResolver {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  @Mutation(() => Boolean)
  @Public()
  @RateLimit('support_link')
  async requestSupportRecovery(@Args('email') email: string, @Args('newPhone') newPhone: string): Promise<boolean> {
    const e = typeof email === 'string' ? email.trim() : '';
    if (!EMAIL.test(e)) throw appError('BAD_INPUT', 'email');
    const phone = normalizeGhanaPhone(typeof newPhone === 'string' ? newPhone : '');
    if (!phone) throw appError('BAD_INPUT', 'newPhone');
    const token = randomBytes(32).toString('base64url');
    await this.pool.query('select ops.create_support_link($1, $2, $3, $4)', [e, hashToken(token), token, phone]);
    return true;
  }

  @Query(() => SupportLinkView, { nullable: true })
  @Public()
  @RateLimit('support_status')
  async supportLink(@Args('token') token: string): Promise<SupportLinkView | null> {
    if (typeof token !== 'string' || !TOKEN.test(token)) throw appError('BAD_INPUT', 'token');
    const r = await this.pool.query<{ uid: string; display_name: string; expires_at: Date }>('select uid, display_name, expires_at from ops.peek_support_link($1)', [hashToken(token)]);
    const row = r.rows[0];
    return row ? { uid: row.uid, firstName: row.display_name.split(/\s+/)[0] ?? '', expiresAt: row.expires_at.toISOString() } : null;
  }

  @Mutation(() => SupportRequestReceipt)
  @Public()
  @RateLimit('support_link')
  async confirmSupportRecovery(@Args('token') token: string, @Args('newPublicKey') newPublicKey: string): Promise<SupportRequestReceipt> {
    if (typeof token !== 'string' || !TOKEN.test(token)) throw appError('BAD_INPUT', 'token');
    try {
      ed25519KeyBytes(newPublicKey);
    } catch {
      throw appError('BAD_INPUT', 'newPublicKey');
    }
    const statusToken = randomBytes(32).toString('base64url');
    let row: { case_id: string; uid: string; created_at: Date } | undefined;
    try {
      row = (await this.pool.query<{ case_id: string; uid: string; created_at: Date }>('select case_id, uid, created_at from ops.redeem_support_link($1, $2, $3)', [hashToken(token), newPublicKey, hashToken(statusToken)])).rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw appError('CONFLICT');
      throw err;
    }
    if (!row) throw appError('BAD_INPUT', 'token');
    await this.audit.record({ actor: row.uid, action: 'support_case.open', target: row.case_id, outcome: 'ALLOWED', details: { source: 'email_link' } });
    return { caseId: row.case_id, statusToken, earliestAt: supportEarliestAt(new Date(row.created_at)).toISOString() };
  }

  @Query(() => SupportRequestStatus, { nullable: true })
  @Public()
  @RateLimit('support_status')
  async supportRequestStatus(@Args('caseId') caseId: string, @Args('statusToken') statusToken: string): Promise<SupportRequestStatus | null> {
    if (typeof caseId !== 'string' || !/^[0-9a-f-]{36}$/.test(caseId) || typeof statusToken !== 'string' || !TOKEN.test(statusToken)) throw appError('BAD_INPUT', 'caseId');
    const r = await this.pool.query<{ status: string; created_at: Date; closed_reason: string | null; activated_at: Date | null; recovery_status: string | null; executable_at: Date | null }>(
      'select status, created_at, closed_reason, activated_at, recovery_status, executable_at from ops.support_request_status($1, $2)',
      [caseId, hashToken(statusToken)],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      status: row.status,
      earliestAt: supportEarliestAt(new Date(row.created_at)).toISOString(),
      closedReason: row.closed_reason,
      recoveryStatus: row.recovery_status,
      movesAt: row.executable_at ? new Date(row.executable_at).toISOString() : null,
      activated: row.activated_at !== null,
    };
  }

  @Query(() => SupportCaseView, { nullable: true })
  async supportCase(@Context('req') req: ObibaRequest): Promise<SupportCaseView | null> {
    const { uid } = identityOf(req);
    const r = await withUserTx(this.pool, uid, latest);
    return r ? toView(r) : null;
  }

  @Mutation(() => SupportCaseView)
  @RequireFreshSession()
  @RateLimit('support_case')
  async openSupportRecovery(@Context('req') req: ObibaRequest, @Args('newPublicKey') newPublicKey: string): Promise<SupportCaseView> {
    const identity = identityOf(req);
    const uid = identity.uid;
    if (!identity.emailVerified) throw appError('EMAIL_NOT_VERIFIED');
    try {
      ed25519KeyBytes(newPublicKey);
    } catch {
      throw appError('BAD_INPUT', 'newPublicKey');
    }
    return withUserTx(this.pool, uid, async (c) => {
      const a = await c.query<{ account_id: string; status: string }>('select account_id, status from chain.accounts where uid = $1', [uid]);
      const account = a.rows[0];
      if (!account || !['active', 'frozen'].includes(account.status)) throw appError('FORBIDDEN');
      const busy = await c.query("select 1 from ops.recoveries where status in ('REQUESTED', 'SIGNED', 'SUBMITTED', 'PENDING_TIMELOCK', 'CANCEL_REQUESTED')");
      if (busy.rowCount) throw appError('CONFLICT');
      try {
        await c.query("insert into identity.devices(uid, public_key, initial, status) values ($1, $2, false, 'pending')", [uid, newPublicKey]);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw appError('CONFLICT', 'newPublicKey');
        throw err;
      }
      let row: CaseRow;
      try {
        row = (await c.query<CaseRow>(`insert into ops.support_cases(uid, account_id, new_public_key) values ($1, $2, $3) returning ${COLUMNS}`, [uid, account.account_id, newPublicKey])).rows[0]!;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw appError('CONFLICT');
        throw err;
      }
      await notifyUser(c, uid, 'SUPPORT_CASE_OPENED', row.id, true);
      await this.audit.record({ actor: uid, action: 'support_case.open', target: row.id, outcome: 'ALLOWED', requestId: req.requestId }, c);
      return toView(row);
    });
  }

  @Mutation(() => SupportCaseView)
  @RateLimit('money')
  async cancelSupportRecovery(@Context('req') req: ObibaRequest): Promise<SupportCaseView> {
    const { uid } = identityOf(req);
    return withUserTx(this.pool, uid, async (c) => {
      const r = await c.query<CaseRow & { new_public_key: string }>(
        `update ops.support_cases set status = 'CANCELLED', closed_by = $1, closed_reason = 'cancelled by the account holder', updated_at = now()
          where status = any($2) returning ${COLUMNS}`,
        [`user:${uid}`, [...SUPPORT_OPEN_STATES]],
      );
      const row = r.rows[0];
      if (!row) throw appError('CONFLICT');
      await c.query("update identity.devices set status = 'revoked' where uid = $1 and public_key = $2 and status = 'pending'", [uid, row.new_public_key]);
      await notifyUser(c, uid, 'SUPPORT_CASE_CANCELLED', row.id, true);
      await this.audit.record({ actor: uid, action: 'support_case.cancel', target: row.id, outcome: 'ALLOWED', requestId: req.requestId }, c);
      return toView(row);
    });
  }
}
