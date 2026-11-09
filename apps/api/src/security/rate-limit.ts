import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { appError } from '../errors';
import { REDIS } from '../infra/tokens';
import { RATE_LIMIT, SKIP_RATE_LIMIT } from './decorators';
import { requestOf } from './request';

interface Rule {
  points: number;
  duration: number;
  key: 'uid' | 'ip';
  onStoreFailure: 'deny' | 'allow';
}

export const RULES: Record<string, Rule> = {
  graphql_ip: { points: 600, duration: 60, key: 'ip', onStoreFailure: 'allow' },
  graphql_user: { points: 300, duration: 60, key: 'uid', onStoreFailure: 'allow' },
  money: { points: 10, duration: 60, key: 'uid', onStoreFailure: 'deny' },
  money_daily: { points: 100, duration: 86_400, key: 'uid', onStoreFailure: 'deny' },
  register_device: { points: 3, duration: 86_400, key: 'uid', onStoreFailure: 'deny' },
  recovery_kit: { points: 5, duration: 86_400, key: 'uid', onStoreFailure: 'deny' },
  recovery_start: { points: 5, duration: 86_400, key: 'uid', onStoreFailure: 'deny' },
  support_case: { points: 3, duration: 86_400, key: 'uid', onStoreFailure: 'deny' },
  sign_up: { points: 10, duration: 3_600, key: 'ip', onStoreFailure: 'deny' },
  password_reset: { points: 5, duration: 3_600, key: 'ip', onStoreFailure: 'deny' },
  password_reset_email: { points: 3, duration: 3_600, key: 'ip', onStoreFailure: 'deny' },
  verify_email: { points: 5, duration: 3_600, key: 'uid', onStoreFailure: 'deny' },
  support_link: { points: 5, duration: 3_600, key: 'ip', onStoreFailure: 'deny' },
  support_status: { points: 60, duration: 3_600, key: 'ip', onStoreFailure: 'deny' },
  profile: { points: 10, duration: 3_600, key: 'uid', onStoreFailure: 'deny' },
  lookup: { points: 30, duration: 60, key: 'uid', onStoreFailure: 'deny' },
  quote: { points: 20, duration: 60, key: 'uid', onStoreFailure: 'deny' },
  invoice_create: { points: 30, duration: 60, key: 'uid', onStoreFailure: 'deny' },
  invoice_view: { points: 60, duration: 60, key: 'ip', onStoreFailure: 'allow' },
  invoice_pay_quote: { points: 10, duration: 60, key: 'ip', onStoreFailure: 'deny' },
  sandbox: { points: 30, duration: 60, key: 'uid', onStoreFailure: 'allow' },
};

@Injectable()
export class RateLimitService {
  private readonly limiters = new Map<string, RateLimiterRedis>();
  private readonly log = new Logger('RateLimit');

  constructor(@Inject(REDIS) redis: Redis) {
    for (const [name, rule] of Object.entries(RULES)) {
      this.limiters.set(
        name,
        new RateLimiterRedis({ storeClient: redis, keyPrefix: `rl:${name}`, points: rule.points, duration: rule.duration, rejectIfRedisNotReady: true }),
      );
    }
  }

  async consume(name: string, subject: string): Promise<void> {
    const rule = RULES[name];
    const limiter = this.limiters.get(name);
    if (!rule || !limiter) throw new Error(`unknown rate limit rule ${name}`);
    try {
      await limiter.consume(subject);
    } catch (err) {
      if (err instanceof RateLimiterRes) throw appError('RATE_LIMITED');
      this.log.warn(`rate limit store unavailable for ${name}`);
      if (rule.onStoreFailure === 'deny') throw appError('SERVICE_PAUSED');
    }
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limits: RateLimitService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = requestOf(ctx);
    const ip = req.ip ?? 'unknown';
    const uid = req.identity?.uid;
    const named = this.reflector.getAllAndOverride<string[]>(RATE_LIMIT, [ctx.getHandler(), ctx.getClass()]) ?? [];
    await this.limits.consume('graphql_ip', ip);
    if (uid) await this.limits.consume('graphql_user', uid);
    for (const name of named) {
      const rule = RULES[name];
      if (!rule) throw new Error(`unknown rate limit rule ${name}`);
      const subject = rule.key === 'uid' ? uid : ip;
      if (!subject) throw appError('UNAUTHENTICATED');
      await this.limits.consume(name, subject);
    }
    return true;
  }
}
