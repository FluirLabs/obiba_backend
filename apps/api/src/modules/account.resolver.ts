import { Inject } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import type Redis from 'ioredis';
import type { Pool, PoolClient } from 'pg';
import { withUserTx } from '@obiba/db';
import { accountNameProblem, accountNameSuggestions, checkSignupEmail, ed25519KeyBytes, emailJob, enqueueEmail, handleCandidates, handleProblem, normalizeAccountName, normalizeHandle, WATCH_HOT_KEY, WATCH_HOT_MS } from '@obiba/domain';
import { APP_CONFIG, type AppConfig } from '../config';
import { ensureSandboxMirror } from './sandbox-mirror';
import { appError } from '../errors';
import { AccountNameAvailability, Balance, DeviceResult, HandleAvailability, Me, RegisterProfileInput } from '../graphql/types';
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
    const row = await withUserTx(this.pool, uid, async (c) => {
      const r = await c.query<UserRow>(ME_SQL, [uid]);
      if (!r.rows[0] || r.rows[0].handle !== null || req.viewOnly === true) return r.rows[0];
      return { ...r.rows[0], handle: await assignHandle(c, r.rows[0].display_name) };
    });
    if (!row) throw appError('PROFILE_REQUIRED');
    return toMe(row, req.viewOnly === true);
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
    const h = input.handle == null || input.handle.trim() === '' ? null : parse(handle, normalizeHandle(input.handle), 'handle');
    if (h !== null && handleProblem(h) !== null) throw appError('BAD_INPUT', 'handle');
    const accountName = normalizeAccountName(input.accountName);
    if (accountNameProblem(accountName, this.parent()) !== null) throw appError('BAD_INPUT', 'accountName');
    try {
      return await withUserTx(this.pool, identity.uid, async (c) => {
        const existing = await c.query<UserRow>(ME_SQL, [identity.uid]);
        if (existing.rows[0]) return toMe(existing.rows[0]);
        if (await nameTaken(c, accountName)) throw appError('CONFLICT', 'accountName');
        if (h !== null && (await handleTaken(c, h))) throw appError('CONFLICT', 'handle');
        const created = await c.query(
          `insert into identity.users(uid, display_name, phone_e164, email, handle, account_name)
           values ($1, $2, $3, $4, $5, $6) on conflict (uid) do nothing`,
          [identity.uid, name, phone, identity.email, h, accountName],
        );
        if (created.rowCount && h === null) await assignHandle(c, name);
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

  @Query(() => HandleAvailability)
  @RateLimit('lookup')
  async handleAvailability(@Context('req') req: ObibaRequest, @Args('handle') raw: string): Promise<HandleAvailability> {
    const { uid } = identityOf(req);
    const h = normalizeHandle(raw).slice(0, 64);
    return withUserTx(this.pool, uid, async (c) => {
      const problem = handleProblem(h);
      const taken = problem === null && (await handleTaken(c, h));
      const suggestions: string[] = [];
      if (problem !== null || taken) {
        const me = await c.query<{ display_name: string; handle: string | null }>('select display_name, handle from identity.users where uid = $1', [uid]);
        const fromName = handleCandidates(me.rows[0]?.display_name ?? '', 6);
        const seeds = problem === null ? [...handleCandidates(h, 6), ...fromName] : fromName;
        for (const s of new Set(seeds)) {
          if (suggestions.length >= 3) break;
          if (s !== h && s !== me.rows[0]?.handle && !(await handleTaken(c, s))) suggestions.push(s);
        }
      }
      return { handle: h, available: problem === null && !taken, reason: problem ?? (taken ? 'TAKEN' : null), suggestions };
    });
  }

  @Mutation(() => Me)
  @RateLimit('profile')
  async changeHandle(@Context('req') req: ObibaRequest, @Args('handle') raw: string): Promise<Me> {
    const { uid } = identityOf(req);
    const h = normalizeHandle(raw);
    if (handleProblem(h) !== null) throw appError('BAD_INPUT', 'handle');
    try {
      return await withUserTx(this.pool, uid, async (c) => {
        await c.query('select identity.set_my_handle($1)', [h]);
        await this.audit.record({ actor: uid, action: 'profile.handle', outcome: 'ALLOWED', requestId: req.requestId, details: { handle: h } }, c);
        const r = await c.query<UserRow>(ME_SQL, [uid]);
        return toMe(r.rows[0]!);
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw appError('CONFLICT', 'handle');
      throw err;
    }
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

async function handleTaken(c: PoolClient, h: string): Promise<boolean> {
  const r = await c.query<{ taken: boolean }>('select identity.handle_taken($1) as taken', [h]);
  return r.rows[0]?.taken !== false;
}

async function assignHandle(c: PoolClient, displayName: string): Promise<string | null> {
  const fallback = Array.from({ length: 5 }, () => `${handleCandidates(displayName, 1)[0]!.slice(0, 18)}${Math.floor(1000 + Math.random() * 9000)}`);
  for (const candidate of [...handleCandidates(displayName, 12), ...fallback]) {
    if (await handleTaken(c, candidate)) continue;
    await c.query('savepoint assign_handle');
    try {
      const r = await c.query<{ handle: string }>('select identity.set_my_handle($1) as handle', [candidate]);
      await c.query('release savepoint assign_handle');
      return r.rows[0]!.handle;
    } catch (err) {
      await c.query('rollback to savepoint assign_handle');
      if ((err as { code?: string }).code !== '23505') throw err;
    }
  }
  return null;
}

async function nameTaken(c: PoolClient, name: string): Promise<boolean> {
  const r = await c.query<{ taken: boolean }>('select identity.account_name_taken($1) as taken', [name]);
  return r.rows[0]?.taken !== false;
}
