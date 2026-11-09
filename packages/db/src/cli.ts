import { Client } from 'pg';
import { migrate } from './migrate';

async function main(): Promise<void> {
  const url = process.env.MIGRATOR_DATABASE_URL;
  if (!url) throw new Error('MIGRATOR_DATABASE_URL is required');
  const client = new Client({ connectionString: url, statement_timeout: 120_000 });
  await client.connect();
  try {
    const r = await migrate(client);
    process.stdout.write(`applied: ${r.applied.join(', ') || 'none'}; already applied: ${r.skipped.length}\n`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`migration failed: ${err instanceof Error ? err.message : 'unknown error'}\n`);
  process.exit(1);
});
