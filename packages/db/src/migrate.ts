import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';

export const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const LOCK_KEY = 4_731_917_103;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(client: Client, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const result: MigrationResult = { applied: [], skipped: [] };
  await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await client.query('create schema if not exists obiba_migrations');
    await client.query(
      'create table if not exists obiba_migrations.applied (name text primary key, sha256 text not null, applied_at timestamptz not null default now())',
    );
    for (const name of files) {
      const sql = readFileSync(join(dir, name), 'utf8');
      const sha = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ sha256: string }>('select sha256 from obiba_migrations.applied where name = $1', [name]);
      if (existing.rowCount) {
        if (existing.rows[0]!.sha256 !== sha) {
          throw new Error(`migration ${name} was modified after it was applied`);
        }
        result.skipped.push(name);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into obiba_migrations.applied(name, sha256) values ($1, $2)', [name, sha]);
        await client.query('commit');
        result.applied.push(name);
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]);
  }
  return result;
}
