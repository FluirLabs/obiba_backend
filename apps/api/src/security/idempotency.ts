import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { withUserTx } from '@obiba/db';
import { appError } from '../errors';
import { PG_POOL, REDIS } from '../infra/tokens';

const KEY = /^[A-Za-z0-9_-]{16,64}$/;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async run<T>(uid: string, key: string, request: unknown, fn: () => Promise<T>): Promise<T> {
    if (!KEY.test(key)) throw appError('BAD_INPUT', 'idempotencyKey');
    const hash = createHash('sha256').update(stable(request)).digest('hex');
    const lockKey = `idem:${uid}:${key}`;
    let locked: string | null;
    try {
      locked = await this.redis.set(lockKey, '1', 'EX', 600, 'NX');
    } catch {
      throw appError('SERVICE_PAUSED');
    }
    if (locked !== 'OK') throw appError('CONFLICT');
    try {
      const claimed = await withUserTx(this.pool, uid, async (c) => {
        const ins = await c.query(
          "insert into ops.idempotency(uid, key, request_hash, status) values ($1, $2, $3, 'IN_PROGRESS') on conflict do nothing",
          [uid, key, hash],
        );
        if (ins.rowCount === 1) return { fresh: true as const };
        const row = await c.query<{ request_hash: string; status: string; response: T }>(
          'select request_hash, status, response from ops.idempotency where uid = $1 and key = $2',
          [uid, key],
        );
        return { fresh: false as const, row: row.rows[0] };
      });
      if (!claimed.fresh) {
        const row = claimed.row;
        if (!row || row.request_hash !== hash || row.status !== 'DONE') throw appError('CONFLICT');
        return row.response;
      }
      let result: T;
      try {
        result = await fn();
      } catch (err) {
        await withUserTx(this.pool, uid, (c) => c.query('delete from ops.idempotency where uid = $1 and key = $2', [uid, key])).catch(() => undefined);
        throw err;
      }
      await withUserTx(this.pool, uid, (c) =>
        c.query("update ops.idempotency set status = 'DONE', response = $3 where uid = $1 and key = $2", [uid, key, JSON.stringify(result)]),
      );
      return result;
    } finally {
      await this.redis.del(lockKey).catch(() => undefined);
    }
  }
}
