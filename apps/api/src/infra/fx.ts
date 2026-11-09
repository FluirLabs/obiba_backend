import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config';
import { REDIS } from './tokens';

export interface IndicativeRateValue {
  base: string;
  quote: string;
  rate: string;
  source: string;
  asOf: string;
}

interface CachedRate {
  values: Record<string, IndicativeRateValue>;
  fetchedAt: number;
}

const CACHE_KEY = 'fx:usd:v3';
const LOCK_KEY = 'fx:usd:fetch';
const REFRESH_MS = 3600 * 1000;
const LOCK_SECONDS = 300;
const MAX_AGE_MS = 4 * 24 * 3600 * 1000;
const RATE = /^\d{1,6}(\.\d{1,8})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export abstract class FxRates {
  abstract usdRate(currency: string): Promise<IndicativeRateValue | null>;

  usdGhs(): Promise<IndicativeRateValue | null> {
    return this.usdRate('GHS');
  }
}

@Injectable()
export class HttpFxRates extends FxRates {
  private readonly log = new Logger('FxRates');
  private local: CachedRate | null = null;
  private localLockUntil = 0;
  private inflight: Promise<CachedRate | null> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    super();
  }

  async usdRate(currency: string): Promise<IndicativeRateValue | null> {
    if (this.config.FX_PROVIDER === 'off') return null;
    let cached = await this.readCache();
    if (!cached || Date.now() - cached.fetchedAt > REFRESH_MS) {
      this.inflight ??= this.refresh().finally(() => {
        this.inflight = null;
      });
      cached = (await this.inflight) ?? cached;
    }
    const value = cached?.values[currency];
    if (!value || Date.now() - Date.parse(value.asOf) > MAX_AGE_MS) return null;
    return value;
  }

  private async readCache(): Promise<CachedRate | null> {
    try {
      const raw = await this.redis.get(CACHE_KEY);
      const parsed = raw ? (JSON.parse(raw) as CachedRate) : null;
      if (!parsed || typeof parsed.fetchedAt !== 'number' || !parsed.values) return null;
      this.local = parsed;
      return parsed;
    } catch {
      return this.local;
    }
  }

  private async acquireLock(): Promise<boolean> {
    try {
      return (await this.redis.set(LOCK_KEY, '1', 'EX', LOCK_SECONDS, 'NX')) === 'OK';
    } catch {
      if (Date.now() < this.localLockUntil) return false;
      this.localLockUntil = Date.now() + LOCK_SECONDS * 1000;
      return true;
    }
  }

  private async refresh(): Promise<CachedRate | null> {
    if (!(await this.acquireLock())) return null;
    const values = await this.fetchFrankfurter().catch(() => null);
    if (!values) {
      this.log.warn('indicative rate fetch failed');
      return null;
    }
    const entry: CachedRate = { values, fetchedAt: Date.now() };
    this.local = entry;
    await this.redis.set(CACHE_KEY, JSON.stringify(entry), 'PX', MAX_AGE_MS).catch(() => undefined);
    return entry;
  }

  private async fetchFrankfurter(): Promise<Record<string, IndicativeRateValue> | null> {
    const res = await fetch(this.config.FX_URL, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 20_000) return null;
    const body = JSON.parse(text) as unknown;
    const rows = Array.isArray(body) ? body : [body];
    const source = new URL(this.config.FX_URL).host;
    const out: Record<string, IndicativeRateValue> = {};
    for (const r of rows as Array<{ date?: unknown; base?: unknown; quote?: unknown; rate?: unknown }>) {
      if (r.base !== 'USD' || typeof r.quote !== 'string' || !/^[A-Z]{3}$/.test(r.quote) || typeof r.rate !== 'number' || !RATE.test(String(r.rate)) || typeof r.date !== 'string' || !DAY.test(r.date)) continue;
      const asOf = new Date(`${r.date}T00:00:00.000Z`);
      if (Number.isNaN(asOf.getTime()) || asOf.getTime() > Date.now()) continue;
      out[r.quote] = { base: 'USD', quote: r.quote, rate: String(r.rate), source, asOf: asOf.toISOString() };
    }
    return Object.keys(out).length ? out : null;
  }
}
