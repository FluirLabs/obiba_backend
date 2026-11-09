import { Pool, type PoolClient, type PoolConfig } from 'pg';

export { migrate, MIGRATIONS_DIR } from './migrate';

const UID = /^[A-Za-z0-9_-]{6,128}$/;

export function createPool(config: PoolConfig, onError: (err: Error) => void = () => undefined): Pool {
  const pool = new Pool({
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 15_000,
    application_name: 'obiba',
    ...config,
  });
  pool.on('error', onError);
  return pool;
}

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function withUserTx<T>(pool: Pool, uid: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!UID.test(uid)) throw new Error('invalid uid');
  return withTx(pool, async (client) => {
    await client.query("select set_config('obiba.uid', $1, true)", [uid]);
    return fn(client);
  });
}
export { mirrorRealCredits, resolveSandboxReview, settleSandboxOp, type SettledSandboxOp } from './sandbox';
