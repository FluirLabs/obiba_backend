import { BLOCKED_PARTS, RESERVED_ACCOUNT_NAMES } from './account-name';

export type HandleProblem = 'TOO_SHORT' | 'TOO_LONG' | 'CHARACTERS' | 'LOOKS_LIKE_PHONE' | 'RESERVED';

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 24;

const ROOT_MAX = HANDLE_MAX - 4;

export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, '').toLowerCase();
}

export function handleProblem(raw: string): HandleProblem | null {
  const h = normalizeHandle(raw);
  if (h.length < HANDLE_MIN) return 'TOO_SHORT';
  if (h.length > HANDLE_MAX) return 'TOO_LONG';
  if (!/^[a-z0-9_]+$/.test(h)) return 'CHARACTERS';
  if (/^\d{8,}$/.test(h) || /(?:^|\D)(?:233|0)\d{9}(?:\D|$)/.test(h)) return 'LOOKS_LIKE_PHONE';
  if (RESERVED_ACCOUNT_NAMES.has(h) || RESERVED_ACCOUNT_NAMES.has(h.replace(/_/g, ''))) return 'RESERVED';
  const compact = h.replace(/_/g, '');
  if (BLOCKED_PARTS.some((p) => compact.includes(p))) return 'RESERVED';
  return null;
}

function roots(seed: string): string[] {
  const folded = seed.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/^@/, '');
  if (/^[a-z0-9_]+$/.test(folded)) return [folded.slice(0, ROOT_MAX)];
  const words = folded.split(/[^a-z0-9]+/).filter(Boolean);
  const first = words[0] ?? '';
  const last = words.length > 1 ? words[words.length - 1]! : '';
  return [first + last, last ? `${first}_${last}` : '', first].map((r) => r.slice(0, ROOT_MAX));
}

export function handleCandidates(seed: string, max = 40): string[] {
  const all = [...new Set(roots(seed))].filter(Boolean);
  const usable = all.filter((r) => handleProblem(r) === null);
  const base = usable[0] ?? all.find((r) => /^[a-z0-9_]{1,2}$/.test(r)) ?? 'member';
  const out = usable.length || handleProblem(base) !== null ? [...usable] : [base];
  for (let n = 2; out.length < max; n++) {
    const c = `${base}${n}`;
    if (handleProblem(c) === null) out.push(c);
  }
  return out.slice(0, max);
}
