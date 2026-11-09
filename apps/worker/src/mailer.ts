import type { Logger } from 'pino';

export interface MailOptions {
  html?: string;
  idempotencyKey?: string;
  kind?: string;
}

export interface Mailer {
  send(to: string, subject: string, text: string, options?: MailOptions): Promise<{ id?: string } | void>;
}

export class MailProviderError extends Error {
  constructor(
    readonly status: number,
    readonly permanent: boolean,
    readonly code: string,
  ) {
    super(`mail provider failed with status ${status} (${code})`);
  }
}

export interface AccessTokenSource {
  getAccessToken(): Promise<string>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const EMAIL = /^[^@\s<>"\r\n]{1,64}@[^@\s<>"\r\n]{1,190}$/;
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export class GmailMailer implements Mailer {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly sender: string,
    private readonly serviceAccount: string,
    private readonly adc: AccessTokenSource,
    private readonly http: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!EMAIL.test(sender) || !EMAIL.test(serviceAccount)) throw new Error('mail sender and service account must be email addresses');
  }

  private async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt > this.now() + 60_000) return this.cached.token;
    const iat = Math.floor(this.now() / 1000);
    const claims = { iss: this.serviceAccount, sub: this.sender, scope: GMAIL_SCOPE, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 };
    const adcToken = await this.adc.getAccessToken();
    const signed = await this.http(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(this.serviceAccount)}:signJwt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adcToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: JSON.stringify(claims) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!signed.ok) throw new Error(`signJwt failed with status ${signed.status}`);
    const { signedJwt } = (await signed.json()) as { signedJwt?: string };
    if (typeof signedJwt !== 'string') throw new Error('signJwt returned no token');
    const exchanged = await this.http('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedJwt }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!exchanged.ok) throw new Error(`token exchange failed with status ${exchanged.status}`);
    const t = (await exchanged.json()) as { access_token?: string; expires_in?: number };
    if (typeof t.access_token !== 'string') throw new Error('token exchange returned no access token');
    this.cached = { token: t.access_token, expiresAt: this.now() + (t.expires_in ?? 3600) * 1000 };
    return t.access_token;
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    if (!EMAIL.test(to)) throw new Error('invalid recipient');
    if (/[\r\n]/.test(subject)) throw new Error('invalid subject');
    const mime = [
      `From: Obiba <${this.sender}>`,
      `To: <${to}>`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(text, 'utf8').toString('base64'),
    ].join('\r\n');
    const res = await this.http(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(this.sender)}/messages/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw: base64url(mime) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`gmail send failed with status ${res.status}`);
  }
}

const PERMANENT_STATUSES = new Set([400, 422]);

export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly replyTo: string,
    private readonly http: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async send(to: string, subject: string, text: string, options: MailOptions = {}): Promise<{ id?: string }> {
    if (!EMAIL.test(to)) throw new MailProviderError(0, true, 'invalid_recipient');
    if (/[\r\n]/.test(subject)) throw new MailProviderError(0, true, 'invalid_subject');
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' };
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    let res;
    try {
      res = await this.http('https://api.resend.com/emails', {
        method: 'POST',
        headers,
        body: JSON.stringify({ from: this.from, to: [to], reply_to: this.replyTo, subject, text, html: options.html, tags: options.kind ? [{ name: 'kind', value: options.kind }] : undefined }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new MailProviderError(0, false, 'network');
    }
    const body = (await res.json().catch(() => ({}))) as { id?: unknown; name?: unknown };
    if (!res.ok) throw new MailProviderError(res.status, PERMANENT_STATUSES.has(res.status), typeof body.name === 'string' ? body.name.slice(0, 60) : 'unknown');
    return { id: typeof body.id === 'string' ? body.id : undefined };
  }
}

export class LogMailer implements Mailer {
  readonly sent: Array<{ to: string; subject: string; text: string; html?: string }> = [];

  constructor(
    private readonly log: Logger,
    private readonly showBody = false,
  ) {}

  async send(to: string, subject: string, text: string, options: MailOptions = {}): Promise<void> {
    this.sent.push({ to, subject, text, html: options.html });
    this.log.info(this.showBody ? { subject, text } : { subject }, 'email not sent: log mailer in use');
  }
}

const CANCEL_HELP = 'If you did not ask for this, open Obiba on any phone where you are still signed in and cancel the recovery. Your money cannot move to a new device while the recovery can still be cancelled.';

const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const EMAIL_TEMPLATES: Record<string, { subject: string; body: (appOrigin: string, token?: string) => string; needsToken?: boolean }> = {
  SUPPORT_LINK: {
    subject: 'Obiba: restore your account on a new device',
    needsToken: true,
    body: (o, token) =>
      `You asked to restore your Obiba account because you cannot receive codes on your phone number.\n\nOpen this link on the phone or computer you want to use from now on. It works once and expires in 30 minutes:\n${o}/recover?token=${token}\n\nOur support team will then call you before anything changes, and the move takes at least 5 days.\n\nIf you did not ask for this, ignore this email and change your password.`,
  },
  SUPPORT_CASE_COMPLETED: {
    subject: 'Obiba: your account is restored',
    body: (o) => `Your Obiba account now works on your new device, and sign-in codes go to your new phone number.\n\nSign in with your email, your password and the code we text to your new number.\n\n${o}/sign-in`,
  },
  RECOVERY_REQUESTED: {
    subject: 'Obiba: account recovery requested',
    body: (o) => `Someone signed in to your Obiba account and asked to move it to a new device.\n\n${CANCEL_HELP}\n\n${o}`,
  },
  RECOVERY_STARTED: {
    subject: 'Obiba: account recovery started (48 hour wait)',
    body: (o) => `An account recovery has started on the NEAR blockchain. A new device will replace your current devices in 48 hours unless the recovery is cancelled.\n\n${CANCEL_HELP}\n\n${o}`,
  },
  RECOVERY_MIDWAY: {
    subject: 'Obiba: account recovery completes within 24 hours',
    body: (o) => `An account recovery for your Obiba account will complete within 24 hours.\n\n${CANCEL_HELP}\n\n${o}`,
  },
  RECOVERY_COMPLETED: {
    subject: 'Obiba: account recovery completed',
    body: (o) => `Your Obiba account was moved to a new device. Your previous devices can no longer approve payments.\n\nIf you did not do this, contact Obiba support immediately.\n\n${o}`,
  },
  RECOVERY_CANCELLED: {
    subject: 'Obiba: account recovery cancelled',
    body: (o) => `An account recovery for your Obiba account was cancelled from one of your devices. Nothing changed.\n\n${o}`,
  },
  RECOVERY_FAILED: {
    subject: 'Obiba: account recovery did not go through',
    body: (o) => `A recovery request for your Obiba account was not approved. Nothing changed.\n\nIf you did not make this request, change your password.\n\n${o}`,
  },
  SUPPORT_CASE_OPENED: {
    subject: 'Obiba: support asked to restore your account',
    body: (o) => `Someone signed in to your Obiba account and asked our support team to move it to a new device because they cannot receive texts on your number.\n\nOur team will call your registered number before anything happens, and no move can start for at least 72 hours, followed by a 48 hour wait on the blockchain.\n\nIf this was not you, open Obiba on any phone where you are still signed in and cancel the request in Settings, then change your password.\n\n${o}`,
  },
  SUPPORT_CASE_APPROVED: {
    subject: 'Obiba: support approved restoring your account',
    body: (o) => `Our support team verified the request to move your Obiba account to a new device. The move will start once the 72 hour review period is over, followed by a 48 hour wait on the blockchain.\n\n${CANCEL_HELP}\n\n${o}`,
  },
  SUPPORT_CASE_REJECTED: {
    subject: 'Obiba: account restore request declined',
    body: (o) => `Our support team could not verify the request to move your Obiba account to a new device, so nothing changed.\n\nIf you made this request, reply to support for next steps. If you did not, change your password.\n\n${o}`,
  },
  SUPPORT_CASE_CANCELLED: {
    subject: 'Obiba: account restore request cancelled',
    body: (o) => `The request to move your Obiba account to a new device was cancelled. Nothing changed.\n\n${o}`,
  },
  RECOVERY_KIT_CREATED: {
    subject: 'Obiba: Recovery Kit saved',
    body: (o) => `A Recovery Kit was saved for your Obiba account. Keep it offline and private. Obiba will never ask you for it.\n\n${o}`,
  },
  RECOVERY_KIT_REPLACED: {
    subject: 'Obiba: Recovery Kit replaced',
    body: (o) => `Your Obiba Recovery Kit was replaced, and the previous kit no longer works.\n\nIf you did not do this, open Obiba and contact support.\n\n${o}`,
  },
};
