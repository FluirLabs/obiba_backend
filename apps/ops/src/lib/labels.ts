export type Tone = 'positive' | 'caution' | 'critical' | 'info' | 'neutral' | 'muted';

export type HealthState = 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'STALE' | 'UNKNOWN' | 'NOT_CONFIGURED';

export const HEALTH: Record<HealthState, { label: string; tone: Tone; rank: number }> = {
  CRITICAL: { label: 'Critical', tone: 'critical', rank: 0 },
  STALE: { label: 'Stale', tone: 'caution', rank: 1 },
  WARNING: { label: 'Warning', tone: 'caution', rank: 2 },
  UNKNOWN: { label: 'Unknown', tone: 'muted', rank: 3 },
  NOT_CONFIGURED: { label: 'Not configured', tone: 'muted', rank: 4 },
  HEALTHY: { label: 'Healthy', tone: 'positive', rank: 5 },
};

export const TX_TYPES = ['transfer', 'invoice_pay', 'deposit', 'withdrawal', 'invoice_deposit', 'local', 'onchain'] as const;
export type TxType = (typeof TX_TYPES)[number];

export const TX_TYPE_LABEL: Record<TxType, string> = {
  transfer: 'Transfer',
  invoice_pay: 'Invoice payment',
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  invoice_deposit: 'Invoice deposit',
  local: 'Local service',
  onchain: 'On-chain transfer',
};

export const PHASES = ['completed', 'pending', 'review', 'unknown', 'failed', 'refunded'] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE: Record<Phase, { label: string; tone: Tone; explain: string }> = {
  completed: { label: 'Completed', tone: 'positive', explain: 'Settled with authoritative evidence' },
  pending: { label: 'Pending', tone: 'info', explain: 'In progress; no final outcome yet' },
  review: { label: 'In review', tone: 'caution', explain: 'Stopped for a person to decide with evidence' },
  unknown: { label: 'Unknown outcome', tone: 'critical', explain: 'Submitted, but neither settlement nor failure is proven. Never resend.' },
  failed: { label: 'Failed', tone: 'critical', explain: 'Ended without moving funds, or expired before submission' },
  refunded: { label: 'Refunded', tone: 'neutral', explain: 'Returned to the sender' },
};

export function statusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  const s = status.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const SEVERITY: Record<string, { label: string; tone: Tone; rank: number }> = {
  CRITICAL: { label: 'Critical', tone: 'critical', rank: 0 },
  HIGH: { label: 'High', tone: 'critical', rank: 1 },
  MEDIUM: { label: 'Medium', tone: 'caution', rank: 2 },
  LOW: { label: 'Low', tone: 'neutral', rank: 3 },
};

export const RECON: Record<string, { label: string; tone: Tone }> = {
  MATCHED: { label: 'Matched', tone: 'positive' },
  MISMATCHED: { label: 'Mismatched', tone: 'critical' },
  STALE: { label: 'Stale', tone: 'caution' },
  UNKNOWN: { label: 'Unknown', tone: 'muted' },
  VERIFIED: { label: 'Verified', tone: 'positive' },
  UNVERIFIED: { label: 'Unverified', tone: 'caution' },
};

export const KILL_SWITCH_LABEL: Record<string, { title: string; effect: string }> = {
  transfers: { title: 'New transfers', effect: 'Customers cannot prepare new USDC transfers.' },
  deposits: { title: 'New deposits', effect: 'Customers cannot request new cross-chain deposit addresses.' },
  withdrawals: { title: 'New withdrawals', effect: 'Customers cannot start new cross-chain withdrawals.' },
  invoices: { title: 'Invoice payments', effect: 'Merchant invoices cannot be created or paid.' },
  sandbox: { title: 'Local services', effect: 'Mobile money, airtime, data and bill payments are paused.' },
  provisioning: { title: 'Account creation', effect: 'New NEAR Smart Accounts are not provisioned.' },
  relay: { title: 'Relaying', effect: 'Signed operations are queued and not relayed to NEAR.' },
};

export const CAPABILITY_LABEL: Record<string, string> = {
  'overview.read': 'View overview and health',
  'transactions.read': 'Search and inspect transactions',
  'customers.read.masked': 'View customers with masked contact details',
  'ledger.read': 'Inspect ledger and reconciliation',
  'treasury.read': 'View treasury and liquidity',
  'providers.read': 'View providers and networks',
  'jobs.read': 'View jobs and infrastructure',
  'cases.read': 'View cases and incidents',
  'customers.search.contact': 'Search customers by email or phone',
  'customers.reveal': 'Reveal contact details with a reason',
  'cases.verify': 'Verify account restore cases',
  'review.resolve': 'Resolve review cases with evidence',
  'controls.pause': 'Pause and resume processing',
  'audit.read': 'Read the audit trail',
  'reports.export': 'Generate and export reports',
  'incidents.manage': 'Declare, acknowledge and resolve incidents',
  'cases.approve': 'Approve restore cases verified by someone else',
  'accounts.restrict': 'Freeze and unfreeze accounts',
  'pilot.approve': 'Approve pilot access',
  'staff.read': 'View staff and access',
};

export function explorerTx(network: string | null | undefined, hash: string): string {
  return network === 'mainnet' ? `https://nearblocks.io/txns/${hash}` : `https://testnet.nearblocks.io/txns/${hash}`;
}

export function explorerAccount(network: string | null | undefined, account: string): string {
  return network === 'mainnet' ? `https://nearblocks.io/address/${account}` : `https://testnet.nearblocks.io/address/${account}`;
}

const LOCAL_KIND: Record<string, string> = {
  MOMO_FUND: 'Mobile money top-up',
  BANK_FUND: 'Bank top-up',
  AIRTIME: 'Airtime',
  DATA: 'Mobile data',
  ECG: 'Electricity (ECG)',
  WATER: 'Water',
  TV: 'TV subscription',
  MOMO_PAYOUT: 'Mobile money payout',
  BANK_PAYOUT: 'Bank payout',
};

export function counterpartyLabel(type: string, raw: string): string {
  if (type !== 'local') return raw;
  const [kind = '', ...rest] = raw.split(' ');
  const provider = rest.join(' ');
  const label = LOCAL_KIND[kind] ?? statusLabel(kind);
  return provider && !label.includes(provider) ? `${label} · ${provider}` : label;
}
