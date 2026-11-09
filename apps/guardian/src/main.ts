import 'reflect-metadata';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { createPool } from '@obiba/db';
import { KmsSigner, LocalSigner, NearRpc } from '@obiba/near';
import { GuardianModule } from './app';
import { loadGuardianConfig } from './config';
import { Guardian } from './guardian';
import { DevCallerVerifier, FirebaseUserVerifier, GoogleCallerVerifier } from './verifiers';

async function main() {
  const cfg = loadGuardianConfig();
  const pool = createPool({ connectionString: cfg.DATABASE_URL });
  const signer = cfg.SIGNER === 'kms' ? new KmsSigner(new KeyManagementServiceClient() as never, cfg.GUARDIAN_KMS_KEY!) : new LocalSigner(cfg.GUARDIAN_SEED_HEX!, cfg.NODE_ENV === 'production');
  const guardian = new Guardian(pool, new NearRpc(cfg.NEAR_RPC_URLS), signer, new FirebaseUserVerifier(cfg.IDP_PROJECT_ID), {
    networkId: cfg.NEAR_NETWORK,
    tokens: cfg.TOKENS,
    maxCosignUsd: cfg.MAX_COSIGN_USD,
    dailyCosignUsd: cfg.DAILY_COSIGN_USD,
    maxDailyLimitUsd: cfg.MAX_DAILY_LIMIT_USD,
    maxCosignsPerHour: cfg.MAX_COSIGNS_PER_HOUR,
    stepUpMaxAgeSeconds: cfg.STEP_UP_MAX_AGE_SECONDS,
  });
  const callers = cfg.DEV_CALLER_TOKENS ? new DevCallerVerifier(cfg.DEV_CALLER_TOKENS) : new GoogleCallerVerifier(cfg.CALLER_AUDIENCE, new Set([...cfg.ALLOWED_CALLERS, ...cfg.SUPPORT_CALLERS]));
  const app = await NestFactory.create<NestExpressApplication>(GuardianModule.create(guardian, callers, new Set(cfg.SUPPORT_CALLERS)), {
    logger: ['error', 'warn'],
    bodyParser: false,
  });
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '8kb' });
  app.use(helmet());
  app.enableShutdownHooks();
  await app.listen(cfg.PORT, '0.0.0.0');
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : 'startup failed'}\n`);
  process.exit(1);
});
