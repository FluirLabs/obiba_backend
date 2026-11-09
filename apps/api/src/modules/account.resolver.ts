import { Inject } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import type Redis from 'ioredis';
import type { Pool, PoolClient } from 'pg';
import { withUserTx } from '@obiba/db';
import { accountNameProblem, accountNameSuggestions, checkSignupEmail, ed25519KeyBytes, emailJob, enqueueEmail, normalizeAccountName, WATCH_HOT_KEY, WATCH_HOT_MS } from '@obiba/domain';
import { APP_CONFIG, type AppConfig } from '../config';
import { ensureSandboxMirror } from './sandbox-mirror';
import { appError } from '../errors';
import { AccountNameAvailability, Balance, DeviceResult, Me, RegisterProfileInput } from '../graphql/types';
import { AuditService } from '../infra/audit';
import { PG_POOL, REDIS } from '../infra/tokens';
import { AllowWithoutProfile, RateLimit, RequireFreshSession } from '../security/decorators';
import { IdTokenVerifier } from '../security/identity';
import { KillSwitch } from '../security/kill-switch';
import { VIEW_ONLY_TTL_SECONDS, identityOf, viewOnlyKey, type ObibaRequest } from '../security/request';
import { displayName, ghanaPhone, handle, parse } from './validation';

interface UserRow {
  uid: string;
  display_name: string;
  phone_e164: string;
  email: string;
  handle: string | null;
  account_name: string | null;
  pilot_allowed: boolean;
  merchant: boolean;
  account_id: string | null;
  account_status: string | null;
}

const ME_SQL = `
  select u.uid, u.display_name, u.phone_e164, u.email, u.handle, u.account_name, u.pilot_allowed, u.merchant,
         a.account_id, a.status as account_status
    from identity.users u left join chain.accounts a on a.uid = u.uid
   where u.uid = $1`;

function toMe(r: UserRow, viewOnly = false): Me {
  return {
    viewOnly,
    uid: r.uid,
    displayName: r.display_name,
    phone: r.phone_e164,
    email: r.email,
    handle: r.handle,
    accountName: r.account_name,
    pilotAllowed: r.pilot_allowed,
    merchant: r.merchant,
    accountId: r.account_id,
    accountStatus: r.account_status,
  };
}

@Resolver()
export class AccountResolver {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly verifier: IdTokenVerifier,
  ) {}

  @Mutation(() => Boolean)
  @RateLimit('lookup')
  async confirmPhone(@Context('req') req: ObibaRequest): Promise<boolean> {
    const { uid } = identityOf(req);
    const phone = await this.verifier.verifiedPhone(uid).catch(() => null);
    if (!phone) return false;
    try {
      return await withUserTx(this.pool, uid, async (c) => (await c.query<{ ok: boolean }>('select identity.mark_phone_verified($1) as ok', [phone])).rows[0]?.ok === true);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return false;
      throw err;
    }
  }

  @Query(() => Me)
  async me(@Context('req') req: ObibaRequest): Promise<Me> {
    const { uid } = identityOf(req);
    const r = await withUserTx(this.pool, uid, (c) => c.query<UserRow>(ME_SQL, [uid]));
    if (!r.rows[0]) throw appError('PROFILE_REQUIRED');
    return toMe(r.rows[0], req.viewOnly === true);
  }

  @Mutation(() => Boolean)
  @RateLimit('profile')
  async beginViewOnlySession(@Context('req') req: ObibaRequest): Promise<boolean> {
    const { uid, authTime } = identityOf(req);
    await this.redis.set(viewOnlyKey(uid, authTime), '1', 'EX', VIEW_ONLY_TTL_SECONDS);
    await this.audit.record({ actor: uid, action: 'session.view_only', outcome: 'ALLOWED', requestId: req.requestId, details: { auth_time: String(authTime) } });
    return true;
  }

  @Mutation(() => Me)
  @AllowWithoutProfile()
  @RateLimit('profile')
  async registerProfile(@Context('req') req: ObibaRequest, @Args('input') input: RegisterProfileInput): Promise<Me> {
    const identity = identityOf(req);
    const verdict = checkSignupEmail(identity.email, this.config.EXTRA_DISPOSABLE_DOMAINS, this.config.RESERVED_EMAIL_DOMAINS);
    if (!verdict.ok) {
      await this.audit.record({ actor: identity.uid, action: 'profile.register', outcome: 'DENIED', requestId: req.requestId, details: { reason: `email_${verdict.reason}` } });
      throw appError('FORBIDDEN', 'email');
    }
    const name = parse(displayName, input.displayName, 'displayName');
    const phone = ghanaPhone(input.phone);
    const h = input.handle == null ? null : parse(handle, input.handle, 'handle');
    const accountName = normalizeAccountName(input.accountName);
    if (accountNameProblem(accountName, this.parent()) !== null) throw appError('BAD_INPUT', 'accountName');
    try {
      return await withUserTx(this.pool, identity.uid, async (c) => {
        const existing = await c.query<UserRow>(ME_SQL, [identity.uid]);
        if (existing.rows[0]) return toMe(existing.rows[0]);
        if (await nameTaken(c, accountName)) throw appError('CONFLICT', 'accountName');
        const created = await c.query(
          `insert into identity.users(uid, display_name, phone_e164, email, handle, account_name)
           values ($1, $2, $3, $4, $5, $6) on conflict (uid) do nothing`,
          [identity.uid, name, phone, identity.email, h, accountName],
        );
        if (created.rowCount) await enqueueEmail(c, emailJob('WELCOME', { uid: identity.uid }, `welcome:${identity.uid}`, {}));
        const r = await c.query<UserRow>(ME_SQL, [identity.uid]);
        return toMe(r.rows[0]!);
      });
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505') throw appError('CONFLICT', e.constraint === 'users_account_name_key' ? 'accountName' : 'handle');
      throw err;
    }
  }

  @Query(() => AccountNameAvailability)
  @AllowWithoutProfile()
  @RateLimit('lookup')
  async accountNameAvailability(@Context('req') req: ObibaRequest, @Args('name') raw: string): Promise<AccountNameAvailability> {
    const { uid } = identityOf(req);
    const parent = this.parent();
    const name = normalizeAccountName(raw).slice(0, 64);
    return withUserTx(this.pool, uid, async (c) => {
      const problem = accountNameProblem(name, parent);
      const taken = problem === null && (await nameTaken(c, name));
      const suggestions: string[] = [];
      if (problem !== null || taken) {
        for (const s of accountNameSuggestions(name, parent, () => false, 10)) {
          if (suggestions.length >= 3) break;
          if (!(await nameTaken(c, s))) suggestions.push(s);
        }
      }
      const available = problem === null && !taken;
      return { name, accountId: available ? `${name}.${parent}` : null, available, reason: problem ?? (taken ? 'TAKEN' : null), suggestions };
    });
  }

  private parent(): string {
    return this.config.ACCOUNT_SUFFIX.slice(1);
  }

  @Mutation(() => DeviceResult)
  @RequireFreshSession()
  @RateLimit('register_device')
  @KillSwitch('provisioning')
  async registerDevice(@Context('req') req: ObibaRequest, @Args('publicKey') publicKey: string): Promise<DeviceResult> {
    const { uid } = identityOf(req);
    try {
      ed25519KeyBytes(publicKey);
    } catch {
      throw appError('BAD_INPUT', 'publicKey');
    }
    return withUserTx(this.pool, uid, async (c) => {
      const existing = await c.query('select 1 from identity.devices where uid = $1 for update', [uid]);
      if (existing.rowCount) {
        await this.audit.record({ actor: uid, action: 'device.register', outcome: 'DENIED', requestId: req.requestId, details: { reason: 'exists' } }, c);
        throw appError('CONFLICT', 'publicKey');
      }
      try {
        await c.query("insert into identity.devices(uid, public_key, initial, status) values ($1, $2, true, 'pending')", [uid, publicKey]);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw appError('CONFLICT', 'publicKey');
        throw err;
      }
      const pilot = req.profile?.pilot_allowed === true;
      if (pilot) {
        await c.query("insert into infra.outbox(topic, payload) values ('account.provision', $1)", [JSON.stringify({ uid })]);
      }
      await this.audit.record({ actor: uid, action: 'device.register', outcome: 'ALLOWED', requestId: req.requestId, details: { provisioning: pilot } }, c);
      return { publicKey, status: 'pending', provisioningQueued: pilot };
    });
  }

  @Query(() => [Balance])
  async balances(@Context('req') req: ObibaRequest): Promise<Balance[]> {
    const { uid } = identityOf(req);
    void this.redis.zadd(WATCH_HOT_KEY, Date.now() + WATCH_HOT_MS, uid).catch(() => undefined);
    const r = await withUserTx(this.pool, uid, async (c) => {
      await ensureSandboxMirror(c, uid);
      return c.query('select * from ledger.my_balances()');
    });
    return r.rows.map((b) => ({ domain: b.domain, currency: b.currency, posted: b.posted, held: b.held, available: b.available }));
  }
}

async function nameTaken(c: PoolClient, name: string): Promise<boolean> {
  const r = await c.query<{ taken: boolean }>('select identity.account_name_taken($1) as taken', [name]);
  return r.rows[0]?.taken !== false;
}
