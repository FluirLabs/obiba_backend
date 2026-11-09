import type { HealthState, Phase, TxType } from './labels';

export interface Session {
  email: string;
  role: 'viewer' | 'operator' | 'admin';
  entity: string;
  network: 'testnet' | 'mainnet' | null;
  release: string | null;
  serverTime: string;
  capabilities: string[];
}

export interface Signal {
  key: string;
  label: string;
  state: HealthState;
  summary: string;
  source: string;
  observedAt: string | null;
  href: string | null;
}

export interface AttentionItem {
  key: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  title: string;
  detail: string;
  count: number;
  since: string | null;
  href: string;
}

export interface Overview {
  observedAt: string;
  window: string;
  bucket: 'hour' | 'day';
  performance: {
    counts: Record<Phase, number>;
    completionRate: number | null;
    completionFormula: string;
    valueByCurrency: Record<string, Partial<Record<Phase, string>>>;
    volume: { currency: string; inflow: string; outflow: string; journals: number }[];
    series: { at: string; inflow: string; outflow: string }[];
    source: string;
  };
  holds: { active: number; amount: string; oldest: string | null; expired: number };
  outbox: { pending: number; oldest: string | null; dispatched: number };
  signals: Signal[];
  attention: AttentionItem[];
}

export interface TxRow {
  type: TxType;
  id: string;
  uid: string | null;
  accountId: string | null;
  customer: string | null;
  handle: string | null;
  status: string;
  phase: Phase;
  amount: string;
  currency: string;
  counterparty: string;
  reference: string | null;
  rail: string;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  observedAt: string;
  rows: T[];
  nextCursor: string | null;
}

export interface Journal {
  id: string;
  opRef: string;
  kind: string;
  domain: string;
  createdAt: string;
  source?: Record<string, unknown> | null;
  entries: { account: string; kind: string; amount: string; currency: string }[];
}

export interface TxDetail {
  observedAt: string;
  type: TxType;
  id: string;
  status: string;
  phase: Phase;
  amount: string;
  currency: string;
  counterparty: string;
  reference: string | null;
  rail: string;
  createdAt: string;
  updatedAt: string;
  opId: string | null;
  customer: { uid: string; name: string; handle: string | null; status: string; accountId: string | null; accountStatus: string | null } | null;
  states: {
    provider: { name: string; status: string | null; detail: Record<string, unknown> | null; updatedAt: string | null };
    chain: { state: 'OBSERVED' | 'NO_TRANSFER_FOUND' | 'SUBMITTED_NOT_OBSERVED' | 'NOT_SUBMITTED'; txHashes: string[]; ingested: string[]; network: string | null };
    ledger: { state: 'POSTED' | 'RESERVED' | 'RELEASED' | 'NOT_POSTED'; journals: number; holds: string[] };
  };
  settlementPolicy: string;
  evidence: { source: string; verified: boolean; detail: string } | null;
  details: Record<string, unknown>;
  chainEvents: { receiptId: string; logIndex: number; blockHeight: string; token: string; from: string; to: string; amount: string; txHash: string | null; observedAt: string }[];
  journals: Journal[];
  holds: { ref: string; amount: string; currency: string; status: string; createdAt: string; expiresAt: string; closedAt: string | null }[];
  guardian: { outcome: string; rules: Record<string, unknown>; usd: string; decidedAt: string }[];
  jobs: { id: string; topic: string; createdAt: string; dispatchedAt: string | null }[];
  audit: { id: string; at: string; actor: string; action: string; outcome: string }[];
  timeline: { at: string; lane: 'request' | 'provider' | 'chain' | 'ledger' | 'control'; title: string; detail: string | null }[];
  attention: string[];
  review: { type: string; allowed: string[] } | null;
}

export interface CustomerRow {
  uid: string;
  name: string;
  handle: string | null;
  email: string;
  phone: string;
  status: string;
  accountId: string | null;
  accountStatus: string | null;
  phoneVerified: boolean;
  pilot: boolean;
  merchant: boolean;
  internalTester: boolean;
  balance: string | null;
  held: string | null;
  currency: string;
  openCases: number;
  lastActivity: string | null;
  createdAt: string;
}

export interface Balance {
  currency: string;
  posted: string;
  held: string;
  available: string;
  domain: string;
}

export interface CustomerDetail {
  observedAt: string;
  uid: string;
  name: string;
  handle: string | null;
  accountName: string | null;
  email: string;
  phone: string;
  status: string;
  flags: { pilot: boolean; merchant: boolean; internalTester: boolean };
  verification: { email: string; phone: string; identity: string; recoveryKit: string };
  account: { id: string; status: string; createdAt: string; custody: string; lastReconciliation: { matched: boolean; checkedAt: string } | null } | null;
  balances: Balance[];
  localBalances: Balance[];
  devices: { publicKey: string; status: string; initial: boolean; createdAt: string }[];
  cases: { id: string; kind: string; status: string; source: string; createdAt: string; updatedAt: string; verifiedBy: string | null; approvedBy: string | null }[];
  recoveries: { id: string; method: string; status: string; createdAt: string; reason: string | null }[];
  restrictions: { kind: string; effect: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface ReconRow {
  accountId: string;
  tokens: string[];
  ledgerPosted: string;
  chainBalance: string;
  difference: string;
  matched: boolean;
  checkedAt: string;
  mismatchSince: string | null;
  runs: number;
}

export interface LedgerCheck {
  key: string;
  title: string;
  scope: string;
  result: 'MATCHED' | 'MISMATCHED' | 'STALE' | 'UNKNOWN';
  checked: number;
  exceptions: number;
  detail: string;
  observedAt?: string | null;
  byCurrency?: { currency: string; exceptions: number; amount: string }[];
  rows?: { account: string; currency: string; expected: string; actual: string; difference: string }[];
}

export interface LedgerView {
  observedAt: string;
  totals: { domain: string; currency: string; kind: string; accounts: number; posted: string; held: string }[];
  checks: LedgerCheck[];
  reconciliation: { rows: ReconRow[]; accounts: number; mismatched: number; lastCheckedAt: string | null; oldestMismatch: string | null };
  holds: { ref: string; account: string; currency: string; amount: string; status: string; createdAt: string; expiresAt: string; expired: boolean }[];
}

export interface TreasuryView {
  observedAt: string;
  model: string;
  assets: {
    currency: string;
    network: string;
    obibaControlled: { treasury: string; clearing: string; accounts: { ref: string; kind: string; posted: string }[] };
    customerControlled: { posted: string; held: string; accounts: number };
    reserved: { currency: string; amount: string; n: string };
    inTransit: { kind: string; amount: string; count: number }[];
    verification: 'VERIFIED' | 'UNVERIFIED' | 'MISMATCHED';
    verifiedAt: string | null;
  }[];
  operatingAccounts: { account: string; label: string; asset: string; amount: string | null; threshold: string; decimals: number; state: HealthState; observedAt: string | null }[];
  operatingAccountsConfigured: boolean;
  requestsSupported: boolean;
}

export interface ProvidersView {
  observedAt: string;
  providers: { key: string; name: string; role: string; owner: string; state: HealthState; stateNote?: string; metrics: { label: string; value: string }[]; settlementPolicy: string; observedAt: string | null }[];
  assets: { token: string; currency: string; decimals: number; network: string; events: number; lastObserved: string | null }[];
}

export interface JobsView {
  observedAt: string;
  queues: {
    ok: boolean;
    observedAt: string;
    queues: { queue: string; waiting: number; active: number; delayed: number; failed: number; lastCompletedAt: string | null; failures: { job: string; at: string | null; error: string; attempts: number }[] }[];
    workerConnections: number | null;
  };
  outbox: { topic: string; pending: number; oldest: string | null; dispatched24h: number; lastDispatched: string | null; total: number }[];
  stuck: { opId: string; status: string; attempts: number; since: string; uid: string }[];
  streams: { stream: string; height: string; head: number | null; lag: number | null; observedAt: string | null }[];
  heartbeats: { configured: boolean; note: string };
  retryPolicy: string;
}

export interface AuditRow {
  id: string;
  at: string;
  actor: string;
  actorKind: 'staff' | 'customer' | 'service';
  action: string;
  target: string | null;
  outcome: 'ALLOWED' | 'DENIED' | 'FAILED';
  requestId: string | null;
  details: Record<string, unknown>;
}

export interface StaffView {
  observedAt: string;
  source: string;
  members: { email: string; role: string; lastAction: string | null; actions: number; denied: number }[];
  roles: { role: string; capabilities: string[] }[];
  changeProcess: string;
}

export interface SettingsView {
  observedAt: string;
  release: string | null;
  entity: string;
  network: string | null;
  controls: { ok: boolean; switches: { name: string; active: boolean; expiresInSeconds: number | null }[] };
  migrations: { ok: boolean; rows: { name: string; appliedAt: string }[] };
  references: { name: string; value: string }[];
  recovery: { backups: { state: string; note: string }; restoreDrill: { state: string; note: string }; keyCustody: { state: string; note: string }; policy: string };
}

export interface ReviewItem {
  type: 'deposit' | 'withdrawal' | 'invoice_payment' | 'sandbox' | 'op_unknown' | 'recovery_failed';
  id: string;
  uid: string | null;
  status: string;
  detail: Record<string, unknown>;
  updatedAt: string;
}

export interface SupportCaseRow {
  id: string;
  displayName: string;
  accountId: string;
  status: string;
  createdAt: string;
  earliestAt?: string;
}

export interface Incident {
  id: string;
  title: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'INVESTIGATING' | 'RESOLVED';
  summary: string;
  signalKey: string | null;
  resources: string[];
  owner: string | null;
  declaredBy: string;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
  updatedAt: string;
}

export interface IncidentDetail extends Incident {
  events: { id: string; at: string; actor: string; kind: string; body: string; evidence: string | null }[];
}

export interface ReportResult {
  kind: string;
  schemaVersion: number;
  definition: string;
  filters: { from: string; to: string };
  snapshotAt: string;
  generatedBy: string;
  rows: number;
  columns: string[];
  preview: (string | number | null)[][];
  csv: string;
  sha256: string;
}
