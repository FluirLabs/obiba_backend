import { type DynamicModule, Logger, Module, type Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { initializeApp } from 'firebase-admin/app';
import Redis from 'ioredis';
import { LoggerModule } from 'nestjs-pino';
import { createPool } from '@obiba/db';
import { APP_CONFIG, type AppConfig } from './config';
import { loadPersistedOperations, yogaConfig } from './graphql/yoga';
import { HealthController } from './health.controller';
import { AuditService } from './infra/audit';
import { GuardianClient, HttpGuardianClient } from './infra/guardian-client';
import { InfraLifecycle } from './infra/lifecycle';
import { InvoiceSigner, KmsInvoiceSigner, LocalInvoiceSigner } from './infra/invoice-signer';
import { NearChain, RpcNearChain } from './infra/near-chain';
import { PG_POOL, REDIS } from './infra/tokens';
import { loggerParams } from './logging';
import { RealtimeHub } from './infra/realtime';
import { FxRates, HttpFxRates } from './infra/fx';
import { AccountResolver } from './modules/account.resolver';
import { ActivityResolver } from './modules/activity.resolver';
import { EventsResolver } from './modules/events.resolver';
import { LookupResolver } from './modules/lookup.resolver';
import { RecoveryResolver } from './modules/recovery.resolver';
import { SignUpResolver } from './modules/signup.resolver';
import { SupportResolver } from './modules/support.resolver';
import { HumanCheck } from './security/human-check';
import { SigningResolver } from './modules/signing.resolver';
import { WithdrawalsResolver } from './modules/withdrawals.resolver';
import { InvoicesResolver } from './modules/invoices.resolver';
import { PaymentsResolver } from './modules/payments.resolver';
import { SandboxResolver } from './modules/sandbox.resolver';
import { DepositsResolver, ONECLICK } from './modules/deposits.resolver';
import { OneClickClient } from '@obiba/intents';
import { EmailActionsResolver } from './modules/email-actions.resolver';
import { EmailWebhookController } from './modules/email-webhook.controller';
import { KnownClients } from './security/known-clients';
import { AuthGuard } from './security/auth.guard';
import { IdempotencyService } from './security/idempotency';
import { FIREBASE_APP, FirebaseIdTokenVerifier, IdTokenVerifier } from './security/identity';
import { RateLimitGuard, RateLimitService } from './security/rate-limit';
import { KillSwitchGuard } from './security/kill-switch';

export interface AppOptions {
  logDestination?: NodeJS.WritableStream;
}

@Module({})
export class AppModule {
  static create(config: AppConfig, options: AppOptions = {}): DynamicModule {
    const operations = loadPersistedOperations(config.PERSISTED_OPERATIONS_FILE);
    const providers: Provider[] = [
      { provide: APP_CONFIG, useValue: config },
      {
        provide: PG_POOL,
        useFactory: () =>
          createPool({ connectionString: config.DATABASE_URL }, () => new Logger('Database').warn('idle database connection dropped; the pool will reconnect')),
      },
      {
        provide: REDIS,
        useFactory: () => {
          const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 5_000, commandTimeout: 2_000 });
          redis.on('error', () => new Logger('Redis').warn('redis connection error; dependent operations fail closed'));
          return redis;
        },
      },
      { provide: FIREBASE_APP, useFactory: () => initializeApp({ projectId: config.IDP_PROJECT_ID }, `obiba-${process.pid}-${Date.now()}`) },
      { provide: IdTokenVerifier, useClass: FirebaseIdTokenVerifier },
      { provide: InvoiceSigner, useClass: config.INVOICE_SIGNER === 'kms' ? KmsInvoiceSigner : LocalInvoiceSigner },
      { provide: NearChain, useClass: RpcNearChain },
      { provide: GuardianClient, useClass: HttpGuardianClient },
      { provide: ONECLICK, useFactory: () => new OneClickClient(config.ONECLICK_BASE_URL, config.ONECLICK_API_KEY) },
      AuditService,
      InfraLifecycle,
      IdempotencyService,
      RateLimitService,
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_GUARD, useClass: RateLimitGuard },
      { provide: APP_GUARD, useClass: KillSwitchGuard },
      AccountResolver,
      PaymentsResolver,
      InvoicesResolver,
      SandboxResolver,
      DepositsResolver,
      ActivityResolver,
      LookupResolver,
      WithdrawalsResolver,
      RecoveryResolver,
      SupportResolver,
      SignUpResolver,
      EmailActionsResolver,
      KnownClients,
      HumanCheck,
      SigningResolver,
      RealtimeHub,
      { provide: FxRates, useClass: HttpFxRates },
      EventsResolver,
    ];
    return {
      module: AppModule,
      imports: [LoggerModule.forRoot(loggerParams(config, options.logDestination)), GraphQLModule.forRoot(yogaConfig(config, operations))],
      controllers: [HealthController, EmailWebhookController],
      providers,
    };
  }
}
