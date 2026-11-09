export type DepositFailure = 'EXPIRED' | 'REFUNDING' | 'REFUNDED' | 'FAILED';

export interface DepositFacts {
  depositId: string;
  origin: string;
  amount: string | null;
  at: string;
}

export interface CreditFacts {
  units: string;
  decimals: number;
  currency: string;
  reference: string;
  method: string;
  from: string | null;
  at: string;
}

export interface WithdrawalFacts {
  withdrawalId: string;
  units: string;
  decimals: number;
  currency: string;
  destination: string;
  recipient: string;
  received: string | null;
  at: string;
}

export interface DeviceFacts {
  device: string | null;
  browser: string | null;
  ip: string | null;
  at: string;
}

export interface EmailPayloads {
  WELCOME: Record<string, never>;
  VERIFY_EMAIL: Record<string, never>;
  PASSWORD_RESET: { device: string | null; browser: string | null; at: string };
  PASSWORD_CHANGED: { at: string };
  NEW_DEVICE: DeviceFacts;
  DEPOSIT_INITIATED: DepositFacts;
  DEPOSIT_PENDING: DepositFacts;
  DEPOSIT_CONFIRMED: CreditFacts;
  DEPOSIT_REVIEW: DepositFacts;
  DEPOSIT_FAILED: DepositFacts & { reason: DepositFailure };
  WITHDRAWAL_REQUESTED: WithdrawalFacts;
  WITHDRAWAL_PROCESSING: WithdrawalFacts;
  WITHDRAWAL_COMPLETED: WithdrawalFacts;
  WITHDRAWAL_REVIEW: WithdrawalFacts;
  WITHDRAWAL_FAILED: WithdrawalFacts & { refunded: boolean };
}

export type EmailKind = keyof EmailPayloads;

export interface TypedEmailJob<K extends EmailKind = EmailKind> {
  uid?: string;
  email?: string;
  kind: K;
  ref: null;
  dedupe: string;
  data: EmailPayloads[K];
}

export function emailJob<K extends EmailKind>(kind: K, target: { uid?: string; email?: string }, dedupe: string, data: EmailPayloads[K]): TypedEmailJob<K> {
  return { ...target, kind, ref: null, dedupe, data };
}

export async function enqueueEmail(c: { query(sql: string, params: unknown[]): Promise<unknown> }, job: TypedEmailJob): Promise<void> {
  await c.query("insert into infra.outbox(topic, payload) values ('notify.email', $1)", [JSON.stringify(job)]);
}

export function creditDedupeKey(receiptId: string, logIndex: number): string {
  return `credit:${receiptId}:${logIndex}`;
}

const CHAIN_NAMES: Record<string, string> = { TRON: 'Tron', BSC: 'BNB Chain', BASE: 'Base', ARB: 'Arbitrum', SOL: 'Solana' };

export function originLabel(key: string): string {
  if (key === 'SOL') return 'SOL on Solana';
  const [token, chain] = key.split('_');
  const name = chain ? CHAIN_NAMES[chain] : undefined;
  return name ? `${token} on ${name}` : key.replace(/_/g, ' ').slice(0, 64);
}
