import { z } from 'zod';
import { parseTokenSpecs } from '@obiba/domain';

const csv = z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const Schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.coerce.number().int().min(1).max(65535).default(8090),
    NEAR_NETWORK: z.enum(['mainnet', 'testnet', 'sandbox']),
    NEAR_RPC_URLS: csv.pipe(z.array(z.string().url()).min(1)),
    DATABASE_URL: z.string().min(1),
    IDP_PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
    TOKENS: z.string().transform(parseTokenSpecs),
    CALLER_AUDIENCE: z.string().url(),
    ALLOWED_CALLERS: csv.pipe(z.array(z.string().email()).min(1)),
    SUPPORT_CALLERS: z.string().default('').pipe(csv).pipe(z.array(z.string().email())),
    DEV_CALLER_TOKENS: z
      .string()
      .optional()
      .transform((v, ctx) => {
        if (!v) return null;
        try {
          const parsed = JSON.parse(v) as Record<string, unknown>;
          const out = new Map<string, string>();
          for (const [token, email] of Object.entries(parsed)) {
            if (token.length < 24 || typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('bad');
            out.set(token, email);
          }
          return out;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'DEV_CALLER_TOKENS must be a JSON object of token (24+ chars) to caller email' });
          return z.NEVER;
        }
      }),
    STEP_UP_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    SIGNER: z.enum(['kms', 'local']),
    GUARDIAN_KMS_KEY: z.string().optional(),
    GUARDIAN_SEED_HEX: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
  })
  .superRefine((c, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (c.NODE_ENV === 'production' && c.SIGNER !== 'kms') fail('production guardian must sign with Cloud KMS (HSM)');
    if (c.SIGNER === 'kms' && !c.GUARDIAN_KMS_KEY) fail('GUARDIAN_KMS_KEY is required');
    if (c.SIGNER === 'local' && !c.GUARDIAN_SEED_HEX) fail('GUARDIAN_SEED_HEX is required');
    if (c.DEV_CALLER_TOKENS && (c.NODE_ENV === 'production' || c.NEAR_NETWORK === 'mainnet')) fail('DEV_CALLER_TOKENS is for local development only');
    if (c.SUPPORT_CALLERS.some((s) => c.ALLOWED_CALLERS.includes(s))) fail('SUPPORT_CALLERS must be different service accounts from ALLOWED_CALLERS');
  });

export type GuardianConfig = z.infer<typeof Schema>;

export function loadGuardianConfig(env: NodeJS.ProcessEnv = process.env): GuardianConfig {
  const r = Schema.safeParse(env);
  if (!r.success) throw new Error(`invalid configuration:\n- ${r.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('\n- ')}`);
  return r.data;
}
