export const MAIN_QUEUE = 'obiba-main';
export const INGEST_QUEUE = 'obiba-ingest';
export const MAIL_QUEUE = 'obiba-mail';
export const MAIL_ATTEMPTS = 14;

export const TOPICS = {
  provision: 'account.provision',
  relay: 'relay.submit',
  ingest: 'chain.ingest',
  recoverySubmit: 'recovery.submit',
  recoveryCancel: 'recovery.cancel',
  accountCall: 'account.call',
  notifyEmail: 'notify.email',
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

export const TOPIC_QUEUE: Record<Topic, string> = {
  'account.provision': MAIN_QUEUE,
  'relay.submit': MAIN_QUEUE,
  'chain.ingest': INGEST_QUEUE,
  'recovery.submit': MAIN_QUEUE,
  'recovery.cancel': MAIN_QUEUE,
  'account.call': MAIN_QUEUE,
  'notify.email': MAIL_QUEUE,
};

export interface NotifyEmailJob {
  uid?: string;
  email?: string;
  kind: string;
  ref: string | null;
  token?: string;
  dedupe?: string;
  data?: unknown;
}

export interface AccountCallJob {
  call_id: string;
}

export interface RecoveryJob {
  recovery_id: string;
}

export interface ProvisionJob {
  uid: string;
}
export interface RelayJob {
  op_id: string;
}
export const WATCH_HOT_KEY = 'watch:hot';
export const WATCH_HOT_MS = 10 * 60_000;

export interface IngestJob {
  tx_hash: string;
  sender: string;
  deposit_id?: string;
}

export interface TokenSpec {
  token: string;
  decimals: number;
  currency: string;
}

export function parseTokenSpecs(json: string): TokenSpec[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 16) throw new Error('TOKENS must be a non-empty array of at most 16 tokens');
  return parsed.map((t) => {
    const s = t as Partial<TokenSpec>;
    if (typeof s.token !== 'string' || !/^[a-z0-9._-]{2,64}$/.test(s.token)) throw new Error('invalid token account');
    if (!Number.isInteger(s.decimals) || s.decimals! < 0 || s.decimals! > 24) throw new Error('invalid token decimals');
    if (typeof s.currency !== 'string' || !/^[A-Z0-9_]{2,16}$/.test(s.currency)) throw new Error('invalid token currency');
    return { token: s.token, decimals: s.decimals!, currency: s.currency };
  });
}

export type UserEventKind = 'balance' | 'op' | 'deposit' | 'withdrawal' | 'invoice' | 'account' | 'device';

export interface UserEvent {
  kind: UserEventKind;
  id: string;
  status: string;
}

export interface EventPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export const USER_CHANNEL_PREFIX = 'user:';

export function userChannel(uid: string): string {
  return `${USER_CHANNEL_PREFIX}${uid}`;
}

export async function publishUserEvents(publisher: EventPublisher, events: Array<{ uid: string } & UserEvent>): Promise<void> {
  await Promise.allSettled(events.map(({ uid, kind, id, status }) => publisher.publish(userChannel(uid), JSON.stringify({ kind, id, status }))));
}

export function parseUserEvent(message: string): UserEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return null;
  }
  const e = raw as Partial<UserEvent>;
  const kinds: UserEventKind[] = ['balance', 'op', 'deposit', 'withdrawal', 'invoice', 'account', 'device'];
  if (!e || !kinds.includes(e.kind as UserEventKind) || typeof e.id !== 'string' || e.id.length > 64 || typeof e.status !== 'string' || e.status.length > 32) return null;
  return { kind: e.kind as UserEventKind, id: e.id, status: e.status };
}

export const KILL_SWITCHES = ['transfers', 'deposits', 'withdrawals', 'invoices', 'sandbox', 'provisioning', 'relay'] as const;
export type KillSwitchName = (typeof KILL_SWITCHES)[number];
export const MAX_KILL_SWITCH_MINUTES = 72 * 60;

export function killSwitchKey(name: KillSwitchName): string {
  return `ks:${name}`;
}
