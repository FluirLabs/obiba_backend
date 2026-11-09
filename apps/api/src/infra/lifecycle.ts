import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { deleteApp, type App } from 'firebase-admin/app';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { FIREBASE_APP } from '../security/identity';
import { PG_POOL, REDIS } from './tokens';

@Injectable()
export class InfraLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(FIREBASE_APP) private readonly firebase: App,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    await Promise.allSettled([this.pool.end(), deleteApp(this.firebase)]);
  }
}
