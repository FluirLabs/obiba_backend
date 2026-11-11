import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { DelayedError, Queue, Worker, type ConnectionOptions, UnrecoverableError, type Job } from 'bullmq';
import Redis from 'ioredis';
import pino, { type Logger } from 'pino';
import type { Pool } from 'pg';
import { createPool } from '@obiba/db';
import { INGEST_QUEUE, MAIL_QUEUE, MAIN_QUEUE, TOPICS, killSwitchKey, UNCAPPED_USD, type KillSwitchName, type AccountCallJob, type NotifyEmailJob, type ProvisionJob, type RecoveryJob, type RelayJob } from '@obiba/domain';
import { FastNearTxIndex, KmsSigner, LocalSigner, NearRpc, RedisNonceSource, StorageSponsor, TX_INDEX_URLS, type ExpectedCode, type Signer } from '@obiba/near';
import { base58 } from '@scure/base';
import type { WorkerConfig } from './config';
import { DepositPoller, OutboxDispatcher, Provisioner, Reconciler, Relayer, type Budget } from './core';
import { EvmRpc, MAINNET_DESTINATIONS, OneClickClient, parseDestinations } from '@obiba/intents';
import { InvoicePaymentTracker, SandboxSettler, WithdrawalTracker } from './tracking';
import { RecoveryRunner } from './recovery';
import { AccountCallRunner } from './calls';
import { initializeApp } from 'firebase-admin/app';
import { GmailMailer, LogMailer, MailProviderError, ResendMailer, type Mailer } from './mailer';
import { EmailNotifier } from './email/notifier';
import { FirebaseAccountLinks } from './email/links';
import { GoogleAuth } from 'google-auth-library';
import { AccountWatcher } from './watcher';
import { PayPruner } from './prune';

export const REDACT = ['*.signed_delegate', '*.signedDelegate', '*.seed', '*.secret', '*.authorization'];

export class RedisBudget implements Budget {
  constructor(private readonly redis: Redis) {}

  async take(key: string, limit: number, ttlSeconds: number): Promise<boolean> {
    const n = await this.redis.incr(`budget:${key}`);
    if (n === 1) await this.redis.expire(`budget:${key}`, ttlSeconds);
    return n <= limit;
  }
}

function signers(cfg: WorkerConfig): { factory: Signer; relayer: Signer } {
  if (cfg.SIGNER === 'kms') {
    const kms = new KeyManagementServiceClient();
    return { factory: new KmsSigner(kms as never, cfg.FACTORY_KMS_KEY!), relayer: new KmsSigner(kms as never, cfg.RELAYER_KMS_KEY!) };
  }
  const prod = cfg.NODE_ENV === 'production';
  return { factory: new LocalSigner(cfg.FACTORY_SEED_HEX!, prod), relayer: new LocalSigner(cfg.RELAYER_SEED_HEX!, prod) };
}

export class WorkerRuntime {
  private readonly redis: Redis;
  private readonly pool: Pool;
  private readonly log: Logger;
  private readonly queues: Record<string, Queue>;
  private worker: Worker | null = null;
  private mailWorker: Worker | null = null;
  private mailConnection: Redis | null = null;
  private timer: NodeJS.Timeout | null = null;
  readonly provisioner: Provisioner;
  readonly relayer: Relayer;
  readonly dispatcher: OutboxDispatcher;
  readonly deposits: DepositPoller;
  readonly reconciler: Reconciler;
  readonly withdrawals: WithdrawalTracker;
  readonly invoicePayments: InvoicePaymentTracker;
  readonly recoveries: RecoveryRunner;
  readonly calls: AccountCallRunner;
  readonly sandbox: SandboxSettler;
  readonly mailer: Mailer;
  readonly notifier: EmailNotifier;
  readonly watcher: AccountWatcher | null;
  private watchTimer: NodeJS.Timeout | null = null;
  private trackTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private depositTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private readonly pruner: PayPruner;

  constructor(private readonly cfg: WorkerConfig) {
    this.log = pino({ level: cfg.LOG_LEVEL, redact: { paths: REDACT, censor: '[redacted]' } });
    this.redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
    this.redis.on('error', () => this.log.warn('redis connection error'));
    this.pool = createPool({ connectionString: cfg.DATABASE_URL }, () => this.log.warn('idle database connection dropped'));
    const connection = this.redis as unknown as ConnectionOptions;
    this.queues = { [MAIN_QUEUE]: new Queue(MAIN_QUEUE, { connection }), [INGEST_QUEUE]: new Queue(INGEST_QUEUE, { connection }), [MAIL_QUEUE]: new Queue(MAIL_QUEUE, { connection }) };
    const rpc = new NearRpc(cfg.NEAR_RPC_URLS);
    const nonces = new RedisNonceSource(this.redis as never);
    const budget = new RedisBudget(this.redis);
    const { factory, relayer } = signers(cfg);
    const code = cfg.ACCOUNT_CODE_HASH ? { codeHash: base58.decode(cfg.ACCOUNT_CODE_HASH) } : { wasm: readFileSync(cfg.ACCOUNT_WASM_PATH!) };
    const expectedCode: ExpectedCode =
      'codeHash' in code ? { globalCodeHash: cfg.ACCOUNT_CODE_HASH! } : { codeHash: base58.encode(createHash('sha256').update(code.wasm).digest()) };
    const sponsor = new StorageSponsor(rpc, relayer, nonces, cfg.RELAYER_ACCOUNT);
    this.pruner = new PayPruner(rpc, relayer, nonces, cfg.RELAYER_ACCOUNT, cfg.PAY_CONTRACT, this.redis, this.log);
    this.provisioner = new Provisioner(
      this.pool,
      rpc,
      factory,
      relayer,
      nonces,
      budget,
      {
        factoryAccount: cfg.FACTORY_ACCOUNT,
        relayerAccount: cfg.RELAYER_ACCOUNT,
        payContract: cfg.PAY_CONTRACT,
        networkId: cfg.NEAR_NETWORK,
        tokens: cfg.TOKENS,
        guardianPublicKey: cfg.GUARDIAN_PUBLIC_KEY,
        dailyLimitUsd: UNCAPPED_USD,
        maxOpAmountUsd: UNCAPPED_USD,
        fundingYocto: cfg.ACCOUNT_FUNDING_YOCTO,
        deviceAllowanceYocto: cfg.DEVICE_ALLOWANCE_YOCTO,
        storageDepositYocto: cfg.STORAGE_DEPOSIT_YOCTO,
        code,
        expectedCode,
        dailyProvisionCap: cfg.DAILY_PROVISION_CAP,
      },
      this.log,
    );
    this.relayer = new Relayer(
      this.pool,
      rpc,
      relayer,
      nonces,
      budget,
      {
        relayerAccount: cfg.RELAYER_ACCOUNT,
        accountSuffix: `.${cfg.FACTORY_ACCOUNT}`,
        maxGas: BigInt(cfg.MAX_RELAY_GAS_TGAS) * 1_000_000_000_000n,
        maxRelaysPerUserPerDay: cfg.MAX_RELAYS_PER_USER_PER_DAY,
      },
      this.log,
      sponsor,
    );
    this.dispatcher = new OutboxDispatcher(this.pool, this.queues, this.log);
    this.reconciler = new Reconciler(this.pool, rpc, cfg.TOKENS, this.log);
    const oneclick = new OneClickClient(cfg.ONECLICK_BASE_URL, cfg.ONECLICK_API_KEY);
    this.deposits = new DepositPoller(this.pool, oneclick, cfg.INTENTS_TX_SENDER, this.log, this.redis);
    const destinations = cfg.WITHDRAW_DESTINATIONS ? parseDestinations(cfg.WITHDRAW_DESTINATIONS) : cfg.NEAR_NETWORK === 'mainnet' ? MAINNET_DESTINATIONS : [];
    const evm = new Map(Object.entries(cfg.EVM_RPC_URLS).map(([network, url]) => [network, new EvmRpc(url)]));
    this.withdrawals = new WithdrawalTracker(this.pool, oneclick, destinations, evm, this.log, this.redis);
    this.invoicePayments = new InvoicePaymentTracker(this.pool, oneclick, cfg.INTENTS_TX_SENDER, this.log, this.redis);
    this.recoveries = new RecoveryRunner(
      this.pool,
      rpc,
      relayer,
      nonces,
      budget,
      { relayerAccount: cfg.RELAYER_ACCOUNT, accountSuffix: `.${cfg.FACTORY_ACCOUNT}`, maxGas: BigInt(cfg.MAX_RELAY_GAS_TGAS) * 1_000_000_000_000n },
      this.log,
      this.redis,
      sponsor,
    );
    this.mailer =
      cfg.MAIL_MODE === 'resend'
        ? new ResendMailer(cfg.RESEND_API_KEY!, cfg.MAIL_FROM, cfg.MAIL_REPLY_TO)
        : cfg.MAIL_MODE === 'gmail'
        ? new GmailMailer(cfg.MAIL_SENDER!, cfg.MAIL_SERVICE_ACCOUNT!, {
            getAccessToken: async () => {
              const t = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getAccessToken();
              if (!t) throw new Error('no application default credentials');
              return t;
            },
          })
        : new LogMailer(this.log, cfg.MAIL_LOG_BODY === 'on' && cfg.NODE_ENV !== 'production');
    this.notifier = new EmailNotifier(
      this.pool,
      this.mailer,
      { appOrigin: cfg.APP_ORIGIN, assetOrigin: cfg.MAIL_ASSET_ORIGIN ?? cfg.APP_ORIGIN, supportEmail: cfg.MAIL_REPLY_TO },
      cfg.IDP_PROJECT_ID ? new FirebaseAccountLinks(initializeApp({ projectId: cfg.IDP_PROJECT_ID }, `obiba-worker-${process.pid}`), cfg.APP_ORIGIN) : null,
      this.log,
    );
    this.sandbox = new SandboxSettler(this.pool, cfg.SANDBOX_SETTLE_SECONDS, this.log, this.redis);
    this.calls = new AccountCallRunner(
      this.pool,
      rpc,
      relayer,
      nonces,
      budget,
      {
        relayerAccount: cfg.RELAYER_ACCOUNT,
        accountSuffix: `.${cfg.FACTORY_ACCOUNT}`,
        maxGas: BigInt(cfg.MAX_RELAY_GAS_TGAS) * 1_000_000_000_000n,
        maxRelaysPerUserPerDay: cfg.MAX_RELAYS_PER_USER_PER_DAY,
      },
      this.log,
      this.redis,
      sponsor,
    );
    const indexUrl = cfg.TX_INDEX_URL ?? TX_INDEX_URLS[cfg.NEAR_NETWORK];
    this.watcher =
      cfg.ACCOUNT_WATCH === 'on' && indexUrl
        ? new AccountWatcher(this.pool, new FastNearTxIndex(indexUrl), this.queues[INGEST_QUEUE]!, this.redis, budget, { batch: cfg.WATCH_BATCH, maxCallsPerMinute: cfg.WATCH_MAX_CALLS_PER_MINUTE }, this.log)
        : null;
  }

  private async deliverEmail(job: Job<NotifyEmailJob>): Promise<string> {
    try {
      return await this.notifier.deliver(job.data, String(job.id));
    } catch (err) {
      if (err instanceof MailProviderError && err.permanent) throw new UnrecoverableError(err.message);
      throw err;
    }
  }

  start(): void {
    const connection = this.redis.duplicate() as unknown as ConnectionOptions;
    this.worker = new Worker(
      MAIN_QUEUE,
      async (job, token) => {
        const gate: KillSwitchName | null = job.name === TOPICS.provision ? 'provisioning' : job.name === TOPICS.relay || job.name === TOPICS.accountCall ? 'relay' : null;
        if (gate && (await this.redis.exists(killSwitchKey(gate)).catch(() => 1)) > 0) {
          await job.moveToDelayed(Date.now() + 30_000, token);
          throw new DelayedError();
        }
        if (job.name === TOPICS.provision) return this.provisioner.provision((job.data as ProvisionJob).uid);
        if (job.name === TOPICS.relay) return this.relayer.relay((job.data as RelayJob).op_id);
        if (job.name === TOPICS.recoverySubmit) return this.recoveries.submit((job.data as RecoveryJob).recovery_id);
        if (job.name === TOPICS.recoveryCancel) return this.recoveries.cancel((job.data as RecoveryJob).recovery_id);
        if (job.name === TOPICS.accountCall) return this.calls.run((job.data as AccountCallJob).call_id);
        if (job.name === TOPICS.notifyEmail) return this.deliverEmail(job as Job<NotifyEmailJob>);
        throw new Error(`unknown job ${job.name}`);
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.log.error({ job: job?.name, id: job?.id, err: err.message }, 'job failed'));
    this.mailConnection = this.redis.duplicate();
    this.mailWorker = new Worker(MAIL_QUEUE, (job) => this.deliverEmail(job as Job<NotifyEmailJob>), {
      connection: this.mailConnection as unknown as ConnectionOptions,
      concurrency: this.cfg.MAIL_CONCURRENCY,
      limiter: { max: this.cfg.MAIL_RATE_PER_SECOND, duration: 1_000 },
    });
    this.mailWorker.on('failed', (job, err) => {
      const final = !job || err.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts ?? 1);
      this.log.warn({ id: job?.id, kind: (job?.data as NotifyEmailJob | undefined)?.kind, attempts: job?.attemptsMade, err: err.message, final }, 'email attempt failed');
      if (final && job) void this.notifier.markDead(job.data as NotifyEmailJob, String(job.id)).catch(() => undefined);
    });
    const tick = async () => {
      try {
        const leader = await this.redis.set('lock:outbox', process.pid.toString(), 'PX', 2_000, 'NX');
        if (leader === 'OK') await this.dispatcher.dispatchBatch();
      } catch (err) {
        this.log.error({ err: (err as Error).message }, 'outbox dispatch failed');
      }
    };
    this.timer = setInterval(() => void tick(), 500);
    const pollDeposits = async () => {
      try {
        const leader = await this.redis.set('lock:deposits', process.pid.toString(), 'PX', 14_000, 'NX');
        if (leader === 'OK') await this.deposits.pollBatch();
      } catch (err) {
        this.log.error({ err: (err as Error).message }, 'deposit polling failed');
      }
    };
    this.depositTimer = setInterval(() => void pollDeposits(), 15_000);
    const track = async () => {
      try {
        const leader = await this.redis.set('lock:tracking', process.pid.toString(), 'PX', 14_000, 'NX');
        if (leader !== 'OK') return;
        await this.withdrawals.trackBatch();
        await this.invoicePayments.trackBatch();
        await this.recoveries.tick();
        await this.sandbox.settleBatch();
        await this.notifier.watchPasswords();
      } catch (err) {
        this.log.error({ err: (err as Error).message }, 'withdrawal or invoice payment tracking failed');
      }
    };
    this.trackTimer = setInterval(() => void track(), 15_000);
    const safety = async () => {
      try {
        const leader = await this.redis.set('lock:reconcile', process.pid.toString(), 'PX', 290_000, 'NX');
        if (leader !== 'OK') return;
        await this.reconciler.reapHolds();
        await this.reconciler.reconcile();
      } catch (err) {
        this.log.error({ err: (err as Error).message }, 'reconciliation failed');
      }
    };
    this.reconcileTimer = setInterval(() => void safety(), 300_000);
    const watch = async () => {
      try {
        const leader = await this.redis.set('lock:watch', process.pid.toString(), 'PX', this.cfg.WATCH_INTERVAL_MS * 6, 'NX');
        if (leader !== 'OK') return;
        try {
          await this.watcher!.tick();
        } finally {
          await this.redis.del('lock:watch');
        }
      } catch (err) {
        this.log.error({ err: (err as Error).message }, 'account watch failed');
      }
    };
    if (this.watcher) this.watchTimer = setInterval(() => void watch(), this.cfg.WATCH_INTERVAL_MS);
    const prune = async () => {
      try {
        const leader = await this.redis.set('lock:prune', process.pid.toString(), 'PX', 3_000_000, 'NX');
        if (leader === 'OK') await this.pruner.tick();
      } catch (err) {
        this.log.error({ err: (err as Error).message }, 'obiba-pay prune failed');
      }
    };
    this.pruneTimer = setInterval(() => void prune(), 3_600_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.depositTimer) clearInterval(this.depositTimer);
    if (this.trackTimer) clearInterval(this.trackTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    await Promise.allSettled([this.worker?.close(), this.mailWorker?.close()]);
    this.mailConnection?.disconnect();
    await Promise.allSettled(Object.values(this.queues).map((q) => q.close()));
    await this.pool.end();
    this.redis.disconnect();
  }
}
