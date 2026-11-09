import { z } from 'zod';

export const ROLES = ['viewer', 'operator', 'admin'] as const;
export type StaffRole = (typeof ROLES)[number];

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  IAP_AUDIENCE: z.string().regex(/^\/projects\/\d+\/(global\/backendServices|apps)\/[\w-]+$/),
  GUARDIAN_URL: z.string().url().optional(),
  GUARDIAN_AUDIENCE: z.string().url().optional(),
  GUARDIAN_DEV_TOKEN: z.string().min(24).optional(),
  DEV_STAFF_LOGIN: z.enum(['on', 'off']).default('off'),
  IDP_PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/).optional(),
  ENTITY_NAME: z.string().regex(/^[\x20-\x7e]{2,60}$/).default('Obiba Ghana'),
  NEAR_NETWORK: z.enum(['testnet', 'mainnet']).optional(),
  NEAR_RPC_URL: z.string().url().optional(),
  RELEASE_ID: z.string().regex(/^[\w.+-]{1,64}$/).optional(),
  WATCH_ACCOUNTS: z
    .string()
    .default('[]')
    .transform((v, ctx) => {
      try {
        const parsed = JSON.parse(v) as unknown;
        if (!Array.isArray(parsed) || parsed.length > 20) throw new Error('bad');
        return parsed.map((x: { account?: unknown; label?: unknown; minNear?: unknown }) => {
          if (typeof x.account !== 'string' || !/^[a-z0-9._-]{2,64}$/.test(x.account) || typeof x.label !== 'string' || !/^[\x20-\x7e]{2,60}$/.test(x.label) || typeof x.minNear !== 'string' || !/^\d{1,40}$/.test(x.minNear)) throw new Error('bad');
          return { account: x.account, label: x.label, minNear: x.minNear };
        });
      } catch {
        ctx.addIssue({ code: 'custom', message: 'WATCH_ACCOUNTS must be a JSON array of {account, label, minNear (yoctoNEAR)}' });
        return z.NEVER;
      }
    }),
  STAFF_ROLES: z.string().transform((v, ctx) => {
    try {
      const parsed = JSON.parse(v) as Record<string, unknown>;
      const out = new Map<string, StaffRole>();
      for (const [email, role] of Object.entries(parsed)) {
        if (!/^[^@\s]{1,64}@[^@\s]{1,190}$/.test(email) || !ROLES.includes(role as StaffRole)) throw new Error('bad entry');
        out.set(email.toLowerCase(), role as StaffRole);
      }
      if (out.size === 0) throw new Error('empty');
      return out;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'STAFF_ROLES must be a non-empty JSON object of email to viewer|operator|admin' });
      return z.NEVER;
    }
  }),
});

const Checked = Schema.superRefine((c, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (c.NODE_ENV === 'production' && (c.GUARDIAN_DEV_TOKEN || c.DEV_STAFF_LOGIN === 'on')) fail('GUARDIAN_DEV_TOKEN and DEV_STAFF_LOGIN are for local development only');
  if (c.NODE_ENV === 'production' && (!c.GUARDIAN_URL || !c.GUARDIAN_AUDIENCE)) fail('production requires GUARDIAN_URL and GUARDIAN_AUDIENCE for support recovery');
  if (c.NODE_ENV === 'production' && c.NEAR_RPC_URL && !c.NEAR_RPC_URL.startsWith('https://')) fail('NEAR_RPC_URL must be https');
  if (c.NODE_ENV === 'production' && !c.IDP_PROJECT_ID) fail('production requires IDP_PROJECT_ID to restore sign-in after a support recovery');
  if (c.NODE_ENV === 'production' && !c.GUARDIAN_URL?.startsWith('https://') && !c.GUARDIAN_URL?.startsWith('http://10.')) fail('GUARDIAN_URL must be https or an internal address');
});

export type AdminConfig = z.infer<typeof Schema>;

export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const r = Checked.safeParse(env);
  if (!r.success) throw new Error(`invalid configuration:\n- ${r.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('\n- ')}`);
  return r.data;
}
