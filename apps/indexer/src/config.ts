import { z } from 'zod';
import { parseTokenSpecs } from '@obiba/domain';

const csv = z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));
const account = z.string().regex(/^[a-z0-9._-]{2,64}$/);

const Schema = z
  .object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  NEAR_RPC_URLS: csv.pipe(z.array(z.string().url()).min(1)),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  FACTORY_ACCOUNT: account,
  PAY_CONTRACT: account,
  TREASURY_ACCOUNT: account,
  TOKENS: z.string().transform(parseTokenSpecs),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
  BLOCK_SOURCE: z.enum(['off', 'neardata', 'rpc', 'filtered']).default('off'),
  NEARDATA_URL: z.string().url().optional(),
  NEARDATA_API_KEY: z.string().min(8).optional(),
  RPC_MAX_RPS: z.coerce.number().min(0).max(1000).default(0),
  BLOCK_STEP_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  BLOCK_PREFETCH: z.coerce.number().int().min(1).max(32).default(8),
  NEARDATA_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(10_000).default(0),
  BLOCK_STREAM_START: z.string().regex(/^\d{1,15}$/).transform(BigInt).optional(),
  })
  .superRefine((c, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (c.NODE_ENV === 'production' && c.BLOCK_SOURCE === 'off') fail('production must stream final blocks to see inbound transfers');
    if ((c.BLOCK_SOURCE === 'neardata' || c.BLOCK_SOURCE === 'filtered') && !c.NEARDATA_URL) fail('NEARDATA_URL is required for the neardata and filtered block sources');
    if (c.NODE_ENV === 'production' && c.NEARDATA_URL && !c.NEARDATA_URL.startsWith('https://')) fail('NEARDATA_URL must be https');
  });

export type IndexerConfig = z.infer<typeof Schema>;

export function loadIndexerConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const r = Schema.safeParse(env);
  if (!r.success) throw new Error(`invalid configuration:\n- ${r.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('\n- ')}`);
  return r.data;
}
