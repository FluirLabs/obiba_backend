export const SUPPORT_REVIEW_HOURS = 72;
export const SUPPORT_CREDENTIAL_QUIET_DAYS = 14;
export const SUPPORT_COSIGN_LOCK_DAYS = 7;
export const SUPPORT_CHECKS = ['called_registered_phone', 'id_name_matches', 'knows_recent_activity'] as const;
export type SupportCheck = (typeof SUPPORT_CHECKS)[number];
export const SUPPORT_OPEN_STATES = ['OPEN', 'VERIFIED', 'APPROVED'] as const;

export function supportChecksPassed(checks: unknown): boolean {
  if (!checks || typeof checks !== 'object') return false;
  const c = checks as Record<string, unknown>;
  return SUPPORT_CHECKS.every((k) => c[k] === true);
}

export function supportEarliestAt(openedAt: Date): Date {
  return new Date(openedAt.getTime() + SUPPORT_REVIEW_HOURS * 3_600_000);
}
