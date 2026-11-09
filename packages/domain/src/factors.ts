export const SECOND_FACTORS = ['phone', 'totp'] as const;

export type SecondFactor = (typeof SECOND_FACTORS)[number];

export function isSecondFactor(factor: string | null | undefined): factor is SecondFactor {
  return factor === 'phone' || factor === 'totp';
}

export function recoveryMethodFor(factor: string | null | undefined): 'SMS' | 'TOTP' | null {
  if (factor === 'phone') return 'SMS';
  if (factor === 'totp') return 'TOTP';
  return null;
}
