import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { withUserTx } from '@obiba/db';
import { isSecondFactor } from '@obiba/domain';
import { APP_CONFIG, type AppConfig } from '../config';
import { appError } from '../errors';
import { PG_POOL, REDIS } from '../infra/tokens';
import { ALLOW_UNVERIFIED, FRESH_SESSION, MERCHANT, PUBLIC, STEP_UP, WITHOUT_PROFILE } from './decorators';
import { KnownClients } from './known-clients';
import { IdTokenVerifier, InvalidTokenError } from './identity';
import { graphqlOperation, requestOf, viewOnlyKey, type Profile } from './request';

const VIEW_ONLY_MUTATIONS = new Set(['signOutEverywhere', 'markNotificationsRead', 'beginViewOnlySession']);

const BEARER = /^Bearer ([A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*)$/;
const MAX_TOKEN_LENGTH = 4096;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: IdTokenVerifier,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly clients: KnownClients,
  ) {}

  private flag(key: string, ctx: ExecutionContext): boolean {
    return this.reflector.getAllAndOverride<boolean>(key, [ctx.getHandler(), ctx.getClass()]) === true;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = requestOf(ctx);
    const header = req.headers.authorization;
    if (this.flag(PUBLIC, ctx) && !header) return true;
    if (typeof header !== 'string' || header.length > MAX_TOKEN_LENGTH + 7) throw appError('UNAUTHENTICATED');
    const match = BEARER.exec(header);
    if (!match) throw appError('UNAUTHENTICATED');

    let identity;
    try {
      identity = await this.verifier.verify(match[1]!);
    } catch (err) {
      if (err instanceof InvalidTokenError) throw appError('UNAUTHENTICATED');
      throw appError('SERVICE_PAUSED');
    }
    if (!(this.config.SIGN_IN_PROVIDERS as readonly string[]).includes(identity.provider)) throw appError('UNAUTHENTICATED');
    if (!identity.emailVerified && !this.config.SKIP_OTP && !this.flag(ALLOW_UNVERIFIED, ctx)) throw appError('EMAIL_NOT_VERIFIED');
    req.identity = identity;

    const rows = await withUserTx(this.pool, identity.uid, (c) =>
      c.query<Profile>('select uid, status, pilot_allowed, merchant from identity.users where uid = $1', [identity.uid]),
    );
    const profile = rows.rows[0];
    if (profile?.status === 'disabled') throw appError('ACCOUNT_DISABLED');
    if (!profile && !this.flag(WITHOUT_PROFILE, ctx) && !this.flag(PUBLIC, ctx)) throw appError('PROFILE_REQUIRED');
    req.profile = profile;
    if (profile) this.clients.observe(req, identity.uid);

    const op = graphqlOperation(ctx);
    const mutation = op?.type === 'mutation';
    let viewOnly: string | null = null;
    try {
      viewOnly = await this.redis.get(viewOnlyKey(identity.uid, identity.authTime));
    } catch {
      if (mutation) throw appError('SERVICE_PAUSED');
    }
    req.viewOnly = viewOnly === '1';
    if (req.viewOnly && mutation && !VIEW_ONLY_MUTATIONS.has(op!.field)) throw appError('VIEW_ONLY');

    if (this.flag(MERCHANT, ctx) && !profile?.merchant) throw appError('FORBIDDEN');
    const age = Math.floor(Date.now() / 1000) - identity.authTime;
    const fresh = age >= 0 && age <= this.config.STEP_UP_MAX_AGE_SECONDS;
    if (this.flag(STEP_UP, ctx) && (!isSecondFactor(identity.secondFactor) || !fresh)) throw appError('STEP_UP_REQUIRED');
    if (this.flag(FRESH_SESSION, ctx) && !fresh) throw appError('STEP_UP_REQUIRED');
    return true;
  }
}
