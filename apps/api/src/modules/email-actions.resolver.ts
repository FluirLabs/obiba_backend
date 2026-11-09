import { createHash, randomUUID } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import type { Pool } from 'pg';
import { emailJob, enqueueEmail } from '@obiba/domain';
import { appError } from '../errors';
import { PG_POOL } from '../infra/tokens';
import { AllowUnverified, AllowWithoutProfile, Public, RateLimit } from '../security/decorators';
import { describeClient } from '../security/known-clients';
import { RateLimitService } from '../security/rate-limit';
import { identityOf, type ObibaRequest } from '../security/request';

const EMAIL = /^[^@\s<>"]{1,64}@[^@\s<>"]{1,190}$/;

@Resolver()
export class EmailActionsResolver {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly limits: RateLimitService,
  ) {}

  @Mutation(() => Boolean)
  @Public()
  @RateLimit('password_reset')
  async requestPasswordReset(@Context('req') req: ObibaRequest, @Args('email') raw: string): Promise<boolean> {
    const email = raw.trim().toLowerCase();
    if (!EMAIL.test(email)) return true;
    try {
      await this.limits.consume('password_reset_email', createHash('sha256').update(email).digest('hex'));
    } catch (err) {
      if ((err as { extensions?: { code?: string } }).extensions?.code === 'RATE_LIMITED') return true;
      throw err;
    }
    const { device, browser } = describeClient(String(req.headers['user-agent'] ?? '').slice(0, 512));
    await enqueueEmail(this.pool, emailJob('PASSWORD_RESET', { email }, `reset:${randomUUID()}`, { device, browser, at: new Date().toISOString() }));
    return true;
  }

  @Mutation(() => Boolean)
  @AllowUnverified()
  @AllowWithoutProfile()
  @RateLimit('verify_email')
  async sendVerificationEmail(@Context('req') req: ObibaRequest): Promise<boolean> {
    const identity = identityOf(req);
    if (identity.emailVerified) return true;
    if (!identity.email) throw appError('BAD_INPUT', 'email');
    await enqueueEmail(this.pool, emailJob('VERIFY_EMAIL', { email: identity.email }, `verify:${randomUUID()}`, {}));
    return true;
  }
}
