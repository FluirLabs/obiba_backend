import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { PG_POOL, REDIS } from './infra/tokens';
import { Public, SkipRateLimit } from './security/decorators';

@Controller()
@Public()
@SkipRateLimit()
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('healthz')
  @HttpCode(200)
  health() {
    return { status: 'ok' };
  }

  @Get('readyz')
  @HttpCode(200)
  async ready() {
    try {
      await this.pool.query('select 1');
      await this.redis.ping();
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
    return { status: 'ready' };
  }
}
