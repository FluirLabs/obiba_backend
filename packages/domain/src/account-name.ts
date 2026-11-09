export type NameProblem = 'TOO_SHORT' | 'TOO_LONG' | 'CHARACTERS' | 'HYPHENS' | 'LOOKS_LIKE_PHONE' | 'RESERVED' | 'TOO_LONG_WITH_PARENT';

export const ACCOUNT_NAME_MIN = 3;
export const ACCOUNT_NAME_MAX = 20;

export const RESERVED_ACCOUNT_NAMES = new Set([
  'account', 'accounts', 'admin', 'administrator', 'airteltigo', 'api', 'app', 'at', 'bank', 'bankofghana', 'billing', 'bog',
  'compliance', 'dev', 'devs', 'ecg', 'factory', 'fees', 'finance', 'gcb', 'ghana', 'gov', 'government', 'guardian', 'gwl', 'help', 'helpdesk',
  'info', 'intents', 'legal', 'mail', 'merchant', 'merchants', 'momo', 'mtn', 'near', 'nia', 'null', 'oneclick', 'ops', 'operator', 'pay',
  'payment', 'payments', 'pilot', 'police', 'relay', 'relayer', 'root', 'sandbox', 'security', 'staff', 'system', 'team', 'telecel', 'test',
  'testnet', 'treasury', 'undefined', 'usdc', 'usdt', 'wallet', 'www',
]);

const BLOCKED_PARTS = ['obiba', 'support', 'admin', 'official', 'verify', 'secure', 'refund', 'helpline', 'customercare'];

export function normalizeAccountName(raw: string): string {
  return raw.trim().toLowerCase();
}

export function accountNameProblem(raw: string, parent: string): NameProblem | null {
  const name = normalizeAccountName(raw);
  if (name.length < ACCOUNT_NAME_MIN) return 'TOO_SHORT';
  if (name.length > ACCOUNT_NAME_MAX) return 'TOO_LONG';
  if (!/^[a-z0-9-]+$/.test(name)) return 'CHARACTERS';
  if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) return 'HYPHENS';
  if (/^\+?\d[\d-]{7,}$/.test(name) || /(?:^|\D)(?:233|0)\d{9}(?:\D|$)/.test(name)) return 'LOOKS_LIKE_PHONE';
  if (RESERVED_ACCOUNT_NAMES.has(name) || /^u-[a-z0-9]{10}$/.test(name)) return 'RESERVED';
  const compact = name.replace(/-/g, '');
  if (BLOCKED_PARTS.some((p) => compact.includes(p))) return 'RESERVED';
  if (`${name}.${parent}`.length > 64) return 'TOO_LONG_WITH_PARENT';
  return null;
}

export function accountIdFor(name: string, parent: string): string {
  const n = normalizeAccountName(name);
  const problem = accountNameProblem(n, parent);
  if (problem) throw new Error(`invalid account name: ${problem}`);
  return `${n}.${parent}`;
}

export function isObibaUserAccount(accountId: string, parent: string): boolean {
  const suffix = `.${parent}`;
  if (!accountId.endsWith(suffix)) return false;
  const label = accountId.slice(0, -suffix.length);
  if (/^u-[a-z0-9]{10}$/.test(label)) return true;
  return accountNameProblem(label, parent) === null;
}

export function accountNameSuggestions(raw: string, parent: string, isTaken: (id: string) => boolean, max = 3): string[] {
  const base = normalizeAccountName(raw).replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, ACCOUNT_NAME_MAX - 4) || 'user';
  const candidates = [`${base}-gh`, `${base}-pay`, ...Array.from({ length: 30 }, (_, i) => `${base}${i + 2}`)];
  const out: string[] = [];
  for (const c of candidates) {
    if (out.length >= max) break;
    if (accountNameProblem(c, parent) !== null) continue;
    if (isTaken(`${c}.${parent}`)) continue;
    out.push(c);
  }
  return out;
}
