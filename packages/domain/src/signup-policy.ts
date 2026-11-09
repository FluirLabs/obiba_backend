export const DISPOSABLE_EMAIL_DOMAINS = [
  '10minutemail.com',
  'dispostable.com',
  'getnada.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'maildrop.cc',
  'mailinator.com',
  'mailnesia.com',
  'mintemail.com',
  'mohmal.com',
  'sharklasers.com',
  'temp-mail.org',
  'tempmail.com',
  'tempmailo.com',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
];

export type EmailVerdict = { ok: true } | { ok: false; reason: 'malformed' | 'disposable' | 'reserved' };

export function checkSignupEmail(email: string, extraDisposable: readonly string[] = [], reservedSuffixes: readonly string[] = ['obibajk.com', 'obiba.app', 'obiba.near', 'obiba.com']): EmailVerdict {
  const m = /^[^@\s]{1,64}@([a-z0-9.-]{1,190})$/.exec(email.toLowerCase());
  if (!m) return { ok: false, reason: 'malformed' };
  const domain = m[1]!;
  const matches = (d: string) => domain === d || domain.endsWith(`.${d}`);
  if (reservedSuffixes.some(matches)) return { ok: false, reason: 'reserved' };
  if ([...DISPOSABLE_EMAIL_DOMAINS, ...extraDisposable].some(matches)) return { ok: false, reason: 'disposable' };
  return { ok: true };
}
