import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Queue, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { MAIL_QUEUE, type EmailKind, type EmailPayloads } from '@obiba/domain';
import { EMAIL_TEMPLATES, ResendMailer } from '../mailer';
import type { RenderedEmail } from './design';
import { esc } from './design';
import { FIXTURES, PREVIEW_BRAND, PREVIEW_LINK } from './fixtures';
import { renderKind, renderNotice } from './templates';

function renderFixture(name: string): RenderedEmail | null {
  const f = FIXTURES.find((x) => x.name === name);
  if (f) return renderKind(f.kind as EmailKind, f.data as EmailPayloads[EmailKind], { brand: PREVIEW_BRAND, name: 'Ama', link: PREVIEW_LINK });
  const legacy = EMAIL_TEMPLATES[name];
  return legacy ? renderNotice(legacy.subject, legacy.body(PREVIEW_BRAND.appOrigin, 'x'.repeat(43)), PREVIEW_BRAND, 'Ama') : null;
}

function allNames(): string[] {
  return [...FIXTURES.map((f) => f.name), ...Object.keys(EMAIL_TEMPLATES)];
}

function preview(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const names = allNames();
  for (const name of names) {
    const r = renderFixture(name)!;
    writeFileSync(join(dir, `${name}.html`), r.html);
    writeFileSync(join(dir, `${name}.txt`), `Subject: ${r.subject}\n\n${r.text}\n`);
  }
  const links = names.map((n) => `<li><a href="${esc(n)}.html" target="view">${esc(n)}</a> <a href="${esc(n)}.txt" target="view">text</a></li>`).join('');
  writeFileSync(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Obiba email previews</title><style>body{margin:0;display:flex;height:100vh;font:14px system-ui}nav{width:280px;overflow:auto;padding:16px;border-right:1px solid #ddd}ul{list-style:none;padding:0}li{padding:4px 0}iframe{flex:1;border:0}</style><nav><ul>${links}</ul></nav><iframe name="view" src="${esc(names[0]!)}.html"></iframe>`);
  process.stdout.write(`Wrote ${names.length} previews to ${resolve(dir, 'index.html')}\n`);
}

async function sendTest(to: string | undefined, name: string): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('test sends are disabled in production');
  if (!to || !process.env.RESEND_API_KEY) throw new Error('usage: RESEND_API_KEY=... mail send-test <to> [fixture]');
  const r = renderFixture(name);
  if (!r) throw new Error(`unknown fixture ${name}`);
  const mailer = new ResendMailer(process.env.RESEND_API_KEY, process.env.MAIL_FROM ?? 'Obiba <no-reply@auth.obibajk.finance>', process.env.MAIL_REPLY_TO ?? 'hello@obibajk.com');
  const sent = await mailer.send(to, r.subject, r.text, { html: r.html, kind: 'TEST' });
  process.stdout.write(`Accepted by provider: ${sent.id ?? 'no id'}\n`);
}

async function deadLetters(retry: boolean): Promise<void> {
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required');
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(MAIL_QUEUE, { connection: redis as unknown as ConnectionOptions });
  try {
    const failed = await queue.getFailed();
    for (const job of failed) {
      process.stdout.write(`${job.id} ${(job.data as { kind?: string }).kind ?? 'unknown'} attempts=${job.attemptsMade}\n`);
      if (retry) await job.retry();
    }
    process.stdout.write(`${failed.length} failed email jobs${retry ? ' requeued' : ''}\n`);
  } finally {
    await queue.close();
    redis.disconnect();
  }
}

async function main(): Promise<void> {
  const [command, a, b] = process.argv.slice(2);
  if (command === 'preview') return preview(a ?? 'email-preview');
  if (command === 'send-test') return sendTest(a, b ?? 'deposit-confirmed');
  if (command === 'dead') return deadLetters(false);
  if (command === 'retry-dead') return deadLetters(true);
  throw new Error('usage: mail preview [dir] | send-test <to> [fixture] | dead | retry-dead');
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : 'failed'}\n`);
  process.exit(1);
});
