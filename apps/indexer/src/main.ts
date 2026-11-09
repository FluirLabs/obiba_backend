import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Worker, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { createPool } from '@obiba/db';
import { INGEST_QUEUE, type IngestJob } from '@obiba/domain';
import { FilteredBlockSource, NearRpc, NeardataSource, RpcBlockSource, type BlockSource } from '@obiba/near';
import { loadIndexerConfig } from './config';
import { Ingestor } from './ingestor';
import { BlockStreamer } from './streamer';

function config() {
  try {
    return loadIndexerConfig();
  } catch (err) {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : 'startup failed'}\n`);
    process.exit(1);
  }
}

const cfg = config();
const log = pino({ level: cfg.LOG_LEVEL });
const pool = createPool({ connectionString: cfg.DATABASE_URL }, () => log.warn('idle database connection dropped'));
const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
redis.on('error', () => log.warn('redis connection error'));
const rpc = new NearRpc(cfg.NEAR_RPC_URLS, 10_000, cfg.RPC_MAX_RPS);
const ingestor = new Ingestor(pool, rpc, {
  tokens: cfg.TOKENS,
  accountSuffix: `.${cfg.FACTORY_ACCOUNT}`,
  payContract: cfg.PAY_CONTRACT,
  treasury: cfg.TREASURY_ACCOUNT,
}, log, redis);
let worker: Worker | null = null;
let streamTimer: NodeJS.Timeout | null = null;
const neardata = cfg.NEARDATA_URL ? new NeardataSource(cfg.NEARDATA_URL, 20_000, cfg.NEARDATA_MIN_INTERVAL_MS, undefined, cfg.NEARDATA_API_KEY ?? null) : null;
const watched = new Set([...cfg.TOKENS.map((t) => t.token), cfg.PAY_CONTRACT, cfg.TREASURY_ACCOUNT, cfg.FACTORY_ACCOUNT]);
const source: BlockSource | null =
  cfg.BLOCK_SOURCE === 'neardata'
    ? neardata
    : cfg.BLOCK_SOURCE === 'filtered'
      ? new FilteredBlockSource(rpc, neardata!, (id) => watched.has(id) || id.endsWith(`.${cfg.FACTORY_ACCOUNT}`), cfg.BLOCK_PREFETCH)
      : cfg.BLOCK_SOURCE === 'rpc'
        ? new RpcBlockSource(rpc)
        : null;
const streamer = source ? new BlockStreamer(pool, source, ingestor, cfg.BLOCK_STREAM_START ?? null, log) : null;
let streaming = false;
const instance = randomUUID();

let failures = 0;
let retryAt = 0;

async function streamTick(): Promise<void> {
  if (!streamer || streaming || Date.now() < retryAt) return;
  streaming = true;
  try {
    const leader = await redis.set('lock:blocks', instance, 'PX', 60_000, 'NX');
    if (leader !== 'OK' && (await redis.get('lock:blocks')) !== instance) return;
    await redis.pexpire('lock:blocks', 60_000);
    const s = await streamer.step(cfg.BLOCK_STEP_SIZE);
    failures = 0;
    if (s.cursor !== null && s.final - s.cursor > 600n) log.warn({ lag: (s.final - s.cursor).toString() }, 'block stream is behind');
    else if (s.processed > 0) log.info({ cursor: s.cursor?.toString(), final: s.final.toString(), processed: s.processed }, 'block stream advanced');
  } catch (err) {
    failures++;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5));
    retryAt = Date.now() + delay / 2 + Math.random() * (delay / 2);
    log.error({ err: (err as Error).message, failures, retryInMs: Math.round(retryAt - Date.now()) }, 'block stream halted at the current height; retrying');
  } finally {
    streaming = false;
  }
}

let lastStats = { at: Date.now(), cursor: null as bigint | null };
setInterval(() => {
  if (!streamer) return;
  void streamer.cursor().then(async (cursor) => {
    const final = await source!.finalHeight().catch(() => null);
    const minutes = (Date.now() - lastStats.at) / 60_000;
    const indexed = cursor !== null && lastStats.cursor !== null ? Number(cursor - lastStats.cursor) : null;
    log.info(
      {
        cursor: cursor?.toString(),
        lag: cursor !== null && final !== null ? (final - cursor).toString() : null,
        blocksPerMinute: indexed !== null ? Math.round(indexed / minutes) : null,
        rpc: { ...rpc.stats },
        neardata: neardata ? { ...neardata.stats } : null,
        rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
      },
      'block stream metrics',
    );
    lastStats = { at: Date.now(), cursor };
  }, () => undefined);
}, 60_000).unref();

@Module({})
class IndexerModule implements OnApplicationBootstrap, OnApplicationShutdown {
  onApplicationBootstrap() {
    worker = new Worker(
      INGEST_QUEUE,
      async (job) => {
        const { tx_hash, sender, deposit_id } = job.data as IngestJob;
        const outcome = await ingestor.ingest(tx_hash, sender, deposit_id);
        if (outcome === 'pending') throw new Error('transaction not final yet');
        return outcome;
      },
      { connection: redis as unknown as ConnectionOptions, concurrency: 4 },
    );
    worker.on('failed', (job, err) => log.error({ id: job?.id, err: err.message }, 'ingest failed'));
    if (streamer) streamTimer = setInterval(() => void streamTick(), 1_000);
  }
  async onApplicationShutdown() {
    if (streamTimer) clearInterval(streamTimer);
    await worker?.close();
    await pool.end();
    redis.disconnect();
  }
}

NestFactory.createApplicationContext(IndexerModule, { logger: ['error', 'warn'] })
  .then((app) => app.enableShutdownHooks())
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : 'startup failed'}\n`);
    process.exit(1);
  });
