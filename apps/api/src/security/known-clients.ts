import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { withUserTx } from '@obiba/db';
import { emailJob, enqueueEmail } from '@obiba/domain';
import { PG_POOL, REDIS } from '../infra/tokens';
import type { ObibaRequest } from './request';

const CLIENT_ID = /^[A-Za-z0-9_-]{22}$/;
const SEEN_TTL_SECONDS = 24 * 3600;

export function describeClient(ua: string): { device: string | null; browser: string | null } {
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android device'
        : /CrOS/.test(ua)
          ? 'Chromebook'
          : /Macintosh/.test(ua)
            ? 'Mac'
            : /Windows NT/.test(ua)
              ? 'Windows PC'
              : /Linux/.test(ua)
                ? 'Linux computer'
                : null;
  const browser = /EdgA?\/|EdgiOS\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /SamsungBrowser\//.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS\//.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(ua)
            ? 'Chrome'
            : /Version\/[\d.]+.*Safari\//.test(ua)
              ? 'Safari'
              : null;
  return { device, browser };
}

@Injectable()
export class KnownClients {
  private readonly log = new Logger('KnownClients');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  observe(req: ObibaRequest, uid: string): void {
    void this.record(req, uid).catch((err: Error) => this.log.warn(`device check skipped: ${err.message}`));
  }

  async record(req: ObibaRequest, uid: string): Promise<void> {
    const header = req.headers['x-obiba-client'];
    const client = typeof header === 'string' && CLIENT_ID.test(header) ? header : null;
    if (!client && req.headers.origin) return;
    const { device, browser } = describeClient(String(req.headers['user-agent'] ?? '').slice(0, 512));
    const fingerprint = createHash('sha256').update(`${uid}:${client ?? `ua:${device}|${browser}`}`).digest('hex');
    if ((await this.redis.set(`known:${fingerprint}`, '1', 'EX', SEEN_TTL_SECONDS, 'NX')) !== 'OK') return;
    const now = new Date();
    await withUserTx(this.pool, uid, async (c) => {
      const prior = await c.query('select 1 from identity.known_clients where uid = $1 limit 1', [uid]);
      const seen = await c.query<{ inserted: boolean }>(
        `insert into identity.known_clients(uid, fingerprint) values ($1, $2)
         on conflict (uid, fingerprint) do update set last_seen_at = now() returning (xmax = 0) as inserted`,
        [uid, fingerprint],
      );
      if (!seen.rows[0]?.inserted || !prior.rowCount) return;
      const day = now.toISOString().slice(0, 10);
      const label = createHash('sha256').update(`${device}|${browser}|${req.ip}`).digest('hex').slice(0, 16);
      await enqueueEmail(c, emailJob('NEW_DEVICE', { uid }, `new_device:${uid}:${day}:${label}`, { device, browser, ip: req.ip ?? null, at: now.toISOString() }));
    });
  }
}
