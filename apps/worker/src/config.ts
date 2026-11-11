import { z } from 'zod';
import { parseTokenSpecs } from '@obiba/domain';

const csv = z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));
const yocto = z.string().regex(/^[1-9]\d{0,30}$/).transform(BigInt);
const account = z.string().regex(/^[a-z0-9._-]{2,64}$/);
const pk = z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
const MAX_ACCOUNT_FLOAT_YOCTO = 10n ** 21n;

const Schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    NEAR_NETWORK: z.enum(['mainnet', 'testnet', 'sandbox']),
    NEAR_RPC_URLS: csv.pipe(z.array(z.string().url()).min(1)),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    FACTORY_ACCOUNT: account,
    RELAYER_ACCOUNT: account,
    PAY_CONTRACT: account,
    TOKENS: z.string().transform(parseTokenSpecs),
    GUARDIAN_PUBLIC_KEY: pk,
    ACCOUNT_FUNDING_YOCTO: yocto,
    DEVICE_ALLOWANCE_YOCTO: yocto,
    STORAGE_DEPOSIT_YOCTO: yocto,
    ACCOUNT_CODE_HASH: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/).optional(),
    ACCOUNT_WASM_PATH: z.string().optional(),
    DAILY_PROVISION_CAP: z.coerce.number().int().min(1).max(10_000).default(50),
    MAX_RELAYS_PER_USER_PER_DAY: z.coerce.number().int().min(1).max(1_000).default(100),
    MAX_RELAY_GAS_TGAS: z.coerce.number().int().min(10).max(300).default(200),
    ONECLICK_BASE_URL: z.string().url().default('https://1click.chaindefuser.com'),
    ONECLICK_API_KEY: z.string().min(10).optional(),
    INTENTS_TX_SENDER: account.default('intents.near'),
    WITHDRAW_DESTINATIONS: z.string().optional(),
    SANDBOX_SETTLE_SECONDS: z.coerce.number().int().min(0).max(300).default(3),
    MAIL_MODE: z.enum(['log', 'gmail', 'resend']).default('log'),
    RESEND_API_KEY: z.string().regex(/^re_[A-Za-z0-9_]{10,}$/).optional(),
    MAIL_FROM: z.string().regex(/^[^<>\r\n]{1,60} <[^@\s<>]+@[^@\s<>]+>$/).default('Obiba <no-reply@auth.obibajk.finance>'),
    MAIL_REPLY_TO: z.string().email().default('hello@obibajk.com'),
    MAIL_ASSET_ORIGIN: z.string().url().optional(),
    MAIL_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
    MAIL_RATE_PER_SECOND: z.coerce.number().int().min(1).max(100).default(2),
    IDP_PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/).optional(),
    MAIL_LOG_BODY: z.enum(['on', 'off']).default('off'),
    MAIL_SENDER: z.string().email().optional(),
    MAIL_SERVICE_ACCOUNT: z.string().email().optional(),
    APP_ORIGIN: z.string().url().default('https://app.obiba.example'),
    EVM_RPC_URLS: z
      .string()
      .default('{}')
      .transform((v, ctx) => {
        try {
          const parsed = JSON.parse(v) as Record<string, unknown>;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          return Object.fromEntries(Object.entries(parsed).map(([k, u]) => [k, z.string().url().parse(u)]));
        } catch {
          ctx.addIssue({ code: 'custom', message: 'EVM_RPC_URLS must be a JSON object of network to https URL' });
          return z.NEVER;
        }
      }),
    SIGNER: z.enum(['kms', 'local']),
    FACTORY_KMS_KEY: z.string().optional(),
    RELAYER_KMS_KEY: z.string().optional(),
    FACTORY_SEED_HEX: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    RELAYER_SEED_HEX: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
    ACCOUNT_WATCH: z.enum(['on', 'off']).default('on'),
    TX_INDEX_URL: z.string().url().optional(),
    WATCH_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(5_000),
    WATCH_BATCH: z.coerce.number().int().min(1).max(100).default(10),
    WATCH_MAX_CALLS_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(60),
  })
  .superRefine((c, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (c.NODE_ENV === 'production' && c.SIGNER !== 'kms') fail('production must sign with Cloud KMS');
    if (c.SIGNER === 'kms' && (!c.FACTORY_KMS_KEY || !c.RELAYER_KMS_KEY)) fail('KMS key names are required');
    if (c.SIGNER === 'local' && (!c.FACTORY_SEED_HEX || !c.RELAYER_SEED_HEX)) fail('local seeds are required');
    if (c.FACTORY_SEED_HEX && c.FACTORY_SEED_HEX === c.RELAYER_SEED_HEX) fail('factory and relayer keys must differ');
    if (!c.ACCOUNT_CODE_HASH && !c.ACCOUNT_WASM_PATH) fail('ACCOUNT_CODE_HASH or ACCOUNT_WASM_PATH is required');
    if (c.NEAR_NETWORK === 'mainnet' && !c.ACCOUNT_CODE_HASH) fail('mainnet accounts must reference the immutable global contract hash');
    if (c.ACCOUNT_FUNDING_YOCTO > MAX_ACCOUNT_FLOAT_YOCTO) fail('accounts are zero-balance; ACCOUNT_FUNDING_YOCTO is only the 1-yocto float for token calls');
    if (c.FACTORY_ACCOUNT === c.RELAYER_ACCOUNT) fail('factory and relayer must be different accounts');
    if (c.NODE_ENV === 'production' && c.MAIL_MODE === 'log') fail('production must send recovery notifications by email');
    if (c.MAIL_MODE === 'resend' && !c.RESEND_API_KEY) fail('RESEND_API_KEY is required for resend');
    if (c.MAIL_MODE === 'resend' && !c.IDP_PROJECT_ID) fail('IDP_PROJECT_ID is required for resend so password reset links can be issued');
    if (c.NODE_ENV === 'production' && c.MAIL_MODE === 'resend' && (!c.APP_ORIGIN.startsWith('https://') || c.APP_ORIGIN.includes('.example'))) fail('APP_ORIGIN must be the live https origin when sending customer email');
    if (c.MAIL_MODE === 'gmail' && (!c.MAIL_SENDER || !c.MAIL_SERVICE_ACCOUNT)) fail('MAIL_SENDER and MAIL_SERVICE_ACCOUNT are required for gmail');
    if (c.NODE_ENV === 'production' && c.TX_INDEX_URL && !c.TX_INDEX_URL.startsWith('https://')) fail('TX_INDEX_URL must be https');
    if (c.NODE_ENV === 'production' && Object.values(c.EVM_RPC_URLS).some((u) => !u.startsWith('https://'))) fail('EVM RPC URLs must be https in production');
  });

export type WorkerConfig = z.infer<typeof Schema>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const r = Schema.safeParse(env);
  if (!r.success) throw new Error(`invalid configuration:\n- ${r.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('\n- ')}`);
  return r.data;
}
