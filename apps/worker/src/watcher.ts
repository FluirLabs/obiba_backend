import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import { TOPICS, WATCH_HOT_KEY, type IngestJob } from '@obiba/domain';
import type { FastNearTxIndex } from '@obiba/near';
import type { Budget } from './core';

const HEIGHTS_KEY = 'watch:height';
const CURSOR_KEY = 'watch:cursor';
const PAUSE_KEY = 'watch:pause';

export interface WatchOptions {
  batch: number;
  maxCallsPerMinute: number;
}

export class AccountWatcher {
  constructor(
    private readonly pool: Pool,
    private readonly index: Pick<FastNearTxIndex, 'accountTxs' | 'signers'>,
    private readonly ingest: Pick<Queue, 'add'>,
    private readonly redis: Redis,
    private readonly budget: Budget,
    private readonly opts: WatchOptions,
    private readonly log: Logger,
  ) {}

  private async pick(): Promise<string[]> {
    await this.redis.zremrangebyscore(WATCH_HOT_KEY, '-inf', Date.now());
    const hotUids = await this.redis.zrange(WATCH_HOT_KEY, 0, this.opts.batch - 1);
    const hot = hotUids.length
      ? (await this.pool.query<{ account_id: string }>("select account_id from chain.accounts where status = 'active' and uid = any($1) order by account_id", [hotUids])).rows.map((r) => r.account_id)
      : [];
    const room = this.opts.batch - hot.length;
    if (room <= 0) return hot;
    const after = (await this.redis.get(CURSOR_KEY)) ?? '';
    let cold = (
      await this.pool.query<{ account_id: string }>("select account_id from chain.accounts where status = 'active' and account_id > $1 and not (account_id = any($2)) order by account_id limit $3", [after, hot, room])
    ).rows.map((r) => r.account_id);
    if (cold.length < room) {
      const wrap = (
        await this.pool.query<{ account_id: string }>("select account_id from chain.accounts where status = 'active' and account_id <= $1 and not (account_id = any($2)) order by account_id limit $3", [after, hot, room - cold.length])
      ).rows.map((r) => r.account_id);
      cold = [...cold, ...wrap];
    }
    const last = cold[cold.length - 1];
    if (last) await this.redis.set(CURSOR_KEY, cold.length < room ? '' : last);
    return [...new Set([...hot, ...cold])];
  }

  private async call<T>(fn: () => Promise<T>): Promise<T | null> {
    if (!(await this.budget.take('txindex', this.opts.maxCallsPerMinute, 60))) return null;
    try {
      return await fn();
    } catch (err) {
      if ((err as { data?: { status?: number } }).data?.status === 429) {
        await this.redis.set(PAUSE_KEY, '1', 'PX', 60_000);
        this.log.warn('tx index rate limited, pausing account watch for 60s');
      } else {
        this.log.warn({ err: (err as Error).message }, 'tx index request failed');
      }
      return null;
    }
  }

  async tick(): Promise<number> {
    if (await this.redis.exists(PAUSE_KEY)) return 0;
    const accounts = await this.pick();
    let queued = 0;
    for (const account of accounts) {
      const seen = await this.redis.hget(HEIGHTS_KEY, account);
      const since = seen ? Number(seen) : 0;
      const hints = await this.call(() => this.index.accountTxs(account, since, seen ? 5 : 1));
      if (hints === null) break;
      if (hints.length === 0) continue;
      const signers = await this.call(() => this.index.signers(hints.map((h) => h.hash)));
      if (signers === null) break;
      for (const h of hints) {
        const sender = signers.get(h.hash);
        if (!sender) continue;
        const job: IngestJob = { tx_hash: h.hash, sender };
        await this.ingest.add(TOPICS.ingest, job, { jobId: `watch-${h.hash}`, attempts: 8, backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: 1_000, removeOnFail: 1_000 });
        queued++;
      }
      if (hints.some((h) => !signers.has(h.hash))) continue;
      await this.redis.hset(HEIGHTS_KEY, account, String(Math.max(since, ...hints.map((h) => h.height))));
    }
    if (queued) this.log.info({ queued }, 'queued account transactions for ingest');
    return queued;
  }
}
