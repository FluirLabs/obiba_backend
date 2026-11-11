import { z } from 'zod';

export const CANONICAL_MAINNET_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const csv = z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const Schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    NEAR_NETWORK: z.enum(['mainnet', 'testnet', 'sandbox']),
    NEAR_RPC_URLS: csv.pipe(z.array(z.string().url()).min(1)),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    IDP_PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
    CORS_ORIGINS: csv.pipe(z.array(z.string().url()).min(1)),
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(2),
    GRAPHQL_ALLOW_ARBITRARY: bool.default(false),
    PERSISTED_OPERATIONS_FILE: z.string().optional(),
    USDC_CONTRACT: z.string().min(2).max(64),
    USDC_LEGACY_CONTRACTS: csv.pipe(z.array(z.string().min(2).max(64)).max(3)).default([]),
    PAY_CONTRACT: z.string().min(2).max(64),
    ACCOUNT_SUFFIX: z.string().regex(/^\.[a-z0-9.-]+$/),
    INVOICE_FEE_BPS: z.coerce.number().int().min(0).max(100),
    INVOICE_SIGNER: z.enum(['kms', 'local']),
    INVOICE_KMS_KEY: z.string().optional(),
    INVOICE_LOCAL_SEED_HEX: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    INVOICE_PUBLIC_KEY: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/),
    ONECLICK_BASE_URL: z.string().url().default('https://1click.chaindefuser.com'),
    ONECLICK_API_KEY: z.string().min(10).optional(),
    ONECLICK_QUOTE_PUBLIC_KEY: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/).default('ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc'),
    ONECLICK_APP_FEE_BPS: z.coerce.number().int().min(0).max(300).default(0),
    ONECLICK_FEE_RECIPIENT: z.string().optional(),
    DEPOSIT_ORIGINS: z.string().optional(),
    WITHDRAW_DESTINATIONS: z.string().optional(),
    INVOICE_CROSSCHAIN: bool.default(false),
    APP_ORIGIN: z.string().url().optional(),
    NEAR_EXPLORER_URL: z.string().url().optional(),
    EXTRA_DISPOSABLE_DOMAINS: csv.default([]),
    SIGN_IN_PROVIDERS: csv.pipe(z.array(z.enum(['password', 'google.com'])).min(1)).default(['password', 'google.com']),
    RESERVED_EMAIL_DOMAINS: csv.default(['obibajk.com', 'obiba.app', 'obiba.near', 'obiba.com']),
    FX_PROVIDER: z.enum(['off', 'frankfurter']).default('off'),
    FX_URL: z.string().url().default('https://api.frankfurter.dev/v2/rates?base=USD&quotes=GHS,KES,NGN,ZAR'),
    INTERNAL_TEST_BILLERS: z
      .string()
      .default('{}')
      .transform((v, ctx) => {
        try {
          const parsed = JSON.parse(v) as Record<string, unknown>;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object');
          for (const h of Object.values(parsed)) if (typeof h !== 'string' || !/^[a-z0-9_]{3,24}$/.test(h)) throw new Error('handle');
          return parsed as Record<string, string>;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'INTERNAL_TEST_BILLERS must map a sandbox kind to a merchant @handle' });
          return z.NEVER;
        }
      }),
    INTERNAL_TEST_MAX_UNITS: z.string().regex(/^[1-9]\d{0,12}$/).transform(BigInt).default(2_000_000n),
    SANDBOX_GHS_PER_USD: z.string().regex(/^[1-9]\d{0,3}(\.\d{1,4})?$/).default('15.00'),
    SANDBOX_SETTLE_SECONDS: z.coerce.number().int().min(0).max(300).default(3),
    GUARDIAN_URL: z.string().url().optional(),
    GUARDIAN_AUDIENCE: z.string().url().optional(),
    GUARDIAN_LOCAL_SEED_HEX: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    GUARDIAN_DEV_TOKEN: z.string().min(24).optional(),
    STEP_UP_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    RESEND_WEBHOOK_SECRET: z.string().regex(/^whsec_[A-Za-z0-9+/=]{16,}$/).optional(),
    TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
    SKIP_OTP: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
  })
  .superRefine((c, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (c.NODE_ENV === 'production') {
      if (c.GRAPHQL_ALLOW_ARBITRARY) fail('production must only accept persisted GraphQL operations');
      if (!c.PERSISTED_OPERATIONS_FILE) fail('production requires PERSISTED_OPERATIONS_FILE');
      if (c.INVOICE_SIGNER !== 'kms') fail('production must sign invoices with Cloud KMS');
      if (c.CORS_ORIGINS.some((o) => !o.startsWith('https://'))) fail('production CORS origins must be https');
      if (c.NEAR_NETWORK === 'sandbox') fail('production cannot run against the sandbox network');
      if (c.LOG_LEVEL === 'debug') fail('debug logging is not allowed in production');
      if (!c.GUARDIAN_URL || !c.GUARDIAN_AUDIENCE) fail('production requires the guardian service');
      if (c.GUARDIAN_LOCAL_SEED_HEX) fail('production must not hold a guardian key');
      if (c.ONECLICK_QUOTE_PUBLIC_KEY !== 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc') fail('production must verify quotes against the real 1Click key');
      if (!c.ONECLICK_BASE_URL.startsWith('https://')) fail('1Click must be reached over https');
      if (!c.APP_ORIGIN?.startsWith('https://')) fail('production requires an https APP_ORIGIN for payment links');
      if (!c.FX_URL.startsWith('https://')) fail('FX_URL must be https');
    }
    if (c.SKIP_OTP && c.NEAR_NETWORK === 'mainnet') fail('SKIP_OTP is not allowed on mainnet');
    if (c.NEAR_NETWORK === 'mainnet' && c.USDC_CONTRACT !== CANONICAL_MAINNET_USDC) fail('mainnet must use canonical USDC');
    if (c.NEAR_NETWORK !== 'mainnet' && c.USDC_CONTRACT === CANONICAL_MAINNET_USDC) fail('non-mainnet must not use mainnet USDC');
    if (c.NEAR_NETWORK === 'mainnet' && c.USDC_LEGACY_CONTRACTS.length > 0) fail('mainnet accepts canonical USDC only');
    if (c.USDC_LEGACY_CONTRACTS.includes(c.USDC_CONTRACT) || c.USDC_LEGACY_CONTRACTS.includes(CANONICAL_MAINNET_USDC)) fail('USDC_LEGACY_CONTRACTS must not repeat the primary or mainnet USDC');
    if (c.GUARDIAN_LOCAL_SEED_HEX && c.NEAR_NETWORK === 'mainnet') fail('mainnet must not hold a guardian key');
    if (c.GUARDIAN_DEV_TOKEN && (c.NODE_ENV === 'production' || c.NEAR_NETWORK === 'mainnet')) fail('GUARDIAN_DEV_TOKEN is for local development only');
    if (c.ONECLICK_APP_FEE_BPS > 0 && !c.ONECLICK_FEE_RECIPIENT) fail('ONECLICK_FEE_RECIPIENT is required when charging an app fee');
    if (c.INVOICE_SIGNER === 'kms' && !c.INVOICE_KMS_KEY) fail('INVOICE_KMS_KEY is required for kms signer');
    if (c.INVOICE_SIGNER === 'local' && !c.INVOICE_LOCAL_SEED_HEX) fail('INVOICE_LOCAL_SEED_HEX is required for local signer');
  });

export type AppConfig = z.infer<typeof Schema>;

export function appOrigin(config: AppConfig): string {
  return (config.APP_ORIGIN ?? config.CORS_ORIGINS[0]!).replace(/\/$/, '');
}

export function explorerAccountUrl(config: AppConfig, accountId: string): string | null {
  const base = config.NEAR_EXPLORER_URL ?? (config.NEAR_NETWORK === 'mainnet' ? 'https://nearblocks.io' : config.NEAR_NETWORK === 'testnet' ? 'https://testnet.nearblocks.io' : null);
  return base ? `${base.replace(/\/$/, '')}/address/${accountId}` : null;
}

export function explorerTxUrl(config: AppConfig, txHash: string | null): string | null {
  if (!txHash) return null;
  const base = config.NEAR_EXPLORER_URL ?? (config.NEAR_NETWORK === 'mainnet' ? 'https://nearblocks.io' : config.NEAR_NETWORK === 'testnet' ? 'https://testnet.nearblocks.io' : null);
  return base ? `${base.replace(/\/$/, '')}/txns/${txHash}` : null;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`);
    throw new ConfigError(`invalid configuration:\n- ${problems.join('\n- ')}`);
  }
  return parsed.data;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
