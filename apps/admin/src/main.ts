import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import Redis from 'ioredis';
import { createPool } from '@obiba/db';
import { AdminService } from './admin';
import { AdminModule } from './app';
import { loadAdminConfig } from './config';
import { DevIapVerifier, GoogleIapVerifier } from './iap';
import { OpsService } from './ops';
import { FirebaseIdentityAdmin } from './identity';
import { DevSupportGuardian, HttpSupportGuardian, SupportService, type SupportGuardian } from './support';

async function main() {
  const cfg = loadAdminConfig();
  const pool = createPool({ connectionString: cfg.DATABASE_URL });
  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  redis.on('error', () => process.stderr.write('redis connection error\n'));
  const guardian: SupportGuardian | null = cfg.GUARDIAN_URL
    ? cfg.GUARDIAN_DEV_TOKEN
      ? new DevSupportGuardian(cfg.GUARDIAN_URL, cfg.GUARDIAN_DEV_TOKEN)
      : cfg.GUARDIAN_AUDIENCE
        ? new HttpSupportGuardian(cfg.GUARDIAN_URL, cfg.GUARDIAN_AUDIENCE)
        : null
    : null;
  const support = new SupportService(pool, redis, guardian, cfg.IDP_PROJECT_ID ? new FirebaseIdentityAdmin(cfg.IDP_PROJECT_ID) : null);
  const devLogin = cfg.DEV_STAFF_LOGIN === 'on' && cfg.NODE_ENV !== 'production';
  const iap = devLogin ? new DevIapVerifier(new Set(cfg.STAFF_ROLES.keys())) : new GoogleIapVerifier(cfg.IAP_AUDIENCE);
  const ops = new OpsService(pool, redis, {
    entity: cfg.ENTITY_NAME,
    network: cfg.NEAR_NETWORK ?? null,
    rpcUrl: cfg.NEAR_RPC_URL ?? null,
    guardianUrl: cfg.GUARDIAN_URL ?? null,
    identityProject: cfg.IDP_PROJECT_ID ?? null,
    release: cfg.RELEASE_ID ?? null,
    watchAccounts: cfg.WATCH_ACCOUNTS,
    staff: cfg.STAFF_ROLES,
  });
  const app = await NestFactory.create<NestExpressApplication>(AdminModule.create(new AdminService(pool, redis), iap, cfg.STAFF_ROLES, support, { devStaff: devLogin ? [...cfg.STAFF_ROLES.keys()] : null }, ops), {
    logger: ['error', 'warn'],
    bodyParser: false,
  });
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '8kb' });
  app.use(helmet());
  app.enableShutdownHooks();
  await app.listen(cfg.PORT, devLogin ? '127.0.0.1' : '0.0.0.0');
  const instance = `${process.pid}-${Date.now()}`;
  setInterval(() => {
    void (async () => {
      try {
        if ((await redis.set('lock:support-submit', instance, 'PX', 55_000, 'NX')) !== 'OK') return;
        await support.submitDue();
        await support.activateCompleted();
      } catch {
        process.stderr.write('support recovery submission failed\n');
      }
    })();
  }, 60_000).unref();
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : 'startup failed'}\n`);
  process.exit(1);
});
