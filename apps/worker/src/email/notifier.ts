import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { withTx } from '@obiba/db';
import { emailJob, enqueueEmail, type EmailKind, type EmailPayloads, type NotifyEmailJob } from '@obiba/domain';
import { EMAIL, EMAIL_TEMPLATES, MailProviderError, type Mailer } from '../mailer';
import type { Brand, RenderedEmail } from './design';
import { CRITICAL_KINDS, EMAIL_SCHEMAS, LINK_KINDS, LINK_MAX_AGE_MS, isEmailKind } from './events';
import { firstName } from './format';
import type { AccountLinks, IssuedLink } from './links';
import { renderKind, renderNotice } from './templates';

const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CLAIM_LEASE = '2 minutes';
const WATCH_INTERVAL_MS = 60_000;
const WATCH_WINDOW = '65 minutes';

export type DeliveryOutcome = 'sent' | 'skipped' | 'duplicate';

export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function dedupeOf(job: NotifyEmailJob, jobId: string): string {
  return job.dedupe ?? `job:${jobId}`;
}

export class EmailNotifier {
  private watchedAt = 0;

  constructor(
    private readonly pool: Pool,
    private readonly mailer: Mailer,
    private readonly brand: Brand,
    private readonly links: AccountLinks | null,
    private readonly log: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async claim(key: string, uid: string | null, kind: string): Promise<'go' | 'done' | 'busy'> {
    const r = await this.pool.query(
      `insert into ops.email_deliveries(dedupe_key, uid, kind, status) values ($1, $2, $3, 'sending')
       on conflict (dedupe_key) do update set status = 'sending', attempts = ops.email_deliveries.attempts + 1, updated_at = now()
        where ops.email_deliveries.status in ('failed', 'dead')
           or (ops.email_deliveries.status = 'sending' and ops.email_deliveries.updated_at < now() - $4::interval)
       returning attempts`,
      [key, uid, kind, CLAIM_LEASE],
    );
    if (r.rowCount) return 'go';
    const existing = await this.pool.query<{ status: string }>('select status from ops.email_deliveries where dedupe_key = $1', [key]);
    return existing.rows[0]?.status === 'sending' ? 'busy' : 'done';
  }

  private async finish(key: string, status: 'sent' | 'skipped' | 'failed', detail: { providerId?: string; error?: string } = {}): Promise<void> {
    await this.pool.query(
      `update ops.email_deliveries set status = $2, provider_id = coalesce($3, provider_id), last_error = $4, updated_at = now(), sent_at = case when $2 = 'sent' then now() else sent_at end where dedupe_key = $1`,
      [key, status, detail.providerId ?? null, detail.error?.slice(0, 200) ?? null],
    );
  }

  async markDead(job: NotifyEmailJob, jobId: string): Promise<void> {
    await this.pool.query("update ops.email_deliveries set status = 'dead', updated_at = now() where dedupe_key = $1 and status <> 'sent'", [dedupeOf(job, jobId)]);
    this.log.error({ kind: job.kind, id: jobId }, 'email dead-lettered');
  }

  private async recipient(job: NotifyEmailJob): Promise<{ email: string; name: string | null } | null> {
    if (job.email) return EMAIL.test(job.email) ? { email: job.email, name: null } : null;
    if (!job.uid) return null;
    const u = (await this.pool.query<{ email: string; display_name: string }>('select email, display_name from identity.users where uid = $1', [job.uid])).rows[0];
    return u && EMAIL.test(u.email) ? { email: u.email, name: firstName(u.display_name) } : null;
  }

  private async suppressed(email: string): Promise<boolean> {
    return ((await this.pool.query('select 1 from ops.email_suppressions where email_hash = $1', [emailHash(email)])).rowCount ?? 0) > 0;
  }

  private async issue(kind: EmailKind, email: string): Promise<IssuedLink | null> {
    if (!this.links) throw new MailProviderError(0, true, 'links_unavailable');
    return kind === 'PASSWORD_RESET' ? this.links.passwordReset(email) : this.links.verifyEmail(email);
  }

  private render(job: NotifyEmailJob, data: unknown, name: string | null, link?: string): RenderedEmail {
    if (isEmailKind(job.kind)) return renderKind(job.kind, data as EmailPayloads[typeof job.kind], { brand: this.brand, name, link });
    const template = EMAIL_TEMPLATES[job.kind]!;
    return renderNotice(template.subject, template.body(this.brand.appOrigin, job.token), this.brand, name);
  }

  async deliver(job: NotifyEmailJob, jobId: string): Promise<DeliveryOutcome> {
    const typed = isEmailKind(job.kind);
    const legacy = typed ? undefined : EMAIL_TEMPLATES[job.kind];
    if (!typed && !legacy) return 'skipped';
    let data: unknown;
    if (typed) {
      const parsed = EMAIL_SCHEMAS[job.kind as EmailKind].safeParse(job.data ?? {});
      if (!parsed.success) {
        this.log.error({ kind: job.kind, id: jobId }, 'email payload rejected');
        throw new MailProviderError(0, true, 'invalid_payload');
      }
      data = parsed.data;
    }
    if (legacy?.needsToken && (!job.token || !LINK_TOKEN.test(job.token))) return 'skipped';
    const key = dedupeOf(job, jobId);
    const claim = await this.claim(key, job.uid ?? null, job.kind);
    if (claim === 'done') return 'duplicate';
    if (claim === 'busy') throw new MailProviderError(0, false, 'claim_busy');
    try {
      return await this.dispatch(job, key, data);
    } catch (err) {
      await this.finish(key, 'failed', { error: err instanceof MailProviderError ? err.code : 'internal' }).catch(() => undefined);
      throw err;
    }
  }

  private async dispatch(job: NotifyEmailJob, key: string, data: unknown): Promise<DeliveryOutcome> {
    const skip = async (reason: string): Promise<DeliveryOutcome> => {
      await this.finish(key, 'skipped', { error: reason });
      this.log.info({ kind: job.kind, reason }, 'email skipped');
      return 'skipped';
    };
    const to = await this.recipient(job);
    if (!to) return skip('no_recipient');
    const critical = CRITICAL_KINDS.has(job.kind) || !isEmailKind(job.kind);
    if (!critical && (await this.suppressed(to.email))) return skip('suppressed');
    let link: IssuedLink | null = null;
    const needsLink = isEmailKind(job.kind) && LINK_KINDS.has(job.kind);
    if (needsLink) {
      const at = Date.parse((data as { at?: string }).at ?? '');
      if (Number.isFinite(at) && this.now() - at > LINK_MAX_AGE_MS) return skip('stale');
      link = await this.issue(job.kind as EmailKind, to.email);
      if (!link) return skip('no_account');
    }
    const message = this.render(job, data, link ? firstName(link.name) : to.name, link?.link);
    const sent = await this.mailer.send(to.email, message.subject, message.text, { html: message.html, kind: job.kind, idempotencyKey: needsLink || job.token ? undefined : key });
    await this.finish(key, 'sent', { providerId: sent ? sent.id : undefined });
    this.log.info({ kind: job.kind, providerId: sent ? sent.id : undefined }, 'email sent');
    if (link && job.kind === 'PASSWORD_RESET') {
      await this.pool.query(
        `insert into ops.password_reset_watches(uid, email, fingerprint, expires_at) values ($1, $2, $3, now() + $4::interval)
         on conflict (uid) do update set expires_at = excluded.expires_at, fingerprint = excluded.fingerprint`,
        [link.uid, to.email, link.fingerprint, WATCH_WINDOW],
      );
    }
    return 'sent';
  }

  async watchPasswords(limit = 25): Promise<number> {
    if (!this.links || this.now() - this.watchedAt < WATCH_INTERVAL_MS) return 0;
    this.watchedAt = this.now();
    await this.pool.query('delete from ops.password_reset_watches where expires_at < now()');
    const rows = (await this.pool.query<{ uid: string; email: string; fingerprint: string }>('select uid, email, fingerprint from ops.password_reset_watches order by created_at limit $1', [limit])).rows;
    let changed = 0;
    for (const w of rows) {
      const current = await this.links.fingerprint(w.uid);
      if (!current || current === w.fingerprint) continue;
      await withTx(this.pool, async (c) => {
        await c.query('delete from ops.password_reset_watches where uid = $1', [w.uid]);
        await enqueueEmail(c, emailJob('PASSWORD_CHANGED', { email: w.email }, `password_changed:${w.uid}:${current.slice(0, 32)}`, { at: new Date(this.now()).toISOString() }));
      });
      changed++;
    }
    return changed;
  }
}
