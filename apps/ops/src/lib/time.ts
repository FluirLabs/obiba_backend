const DATE_TIME = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const DATE_TIME_SHORT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const HOUR = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

function valid(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function dateTime(iso: string | null | undefined): string {
  const d = valid(iso);
  return d ? DATE_TIME.format(d) : '—';
}

export function dateTimeShort(iso: string | null | undefined): string {
  const d = valid(iso);
  return d ? DATE_TIME_SHORT.format(d) : '—';
}

export function dateOnly(iso: string | null | undefined): string {
  const d = valid(iso);
  return d ? DATE.format(d) : '—';
}

export function timeOnly(iso: string | null | undefined): string {
  const d = valid(iso);
  return d ? TIME.format(d) : '—';
}

export function bucketLabel(iso: string, bucket: 'hour' | 'day'): string {
  const d = new Date(iso);
  return bucket === 'hour' ? HOUR.format(d) : DAY.format(d);
}

export function utc(iso: string | null | undefined): string {
  const d = valid(iso);
  return d ? `${d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')} UTC` : '';
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  const d = valid(iso);
  if (!d) return '—';
  const ms = now - d.getTime();
  if (ms < 5_000) return 'just now';
  return `${duration(ms)} ago`;
}

export function age(iso: string | null | undefined, now = Date.now()): string {
  const d = valid(iso);
  return d ? duration(now - d.getTime()) : '—';
}

export function timezoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
