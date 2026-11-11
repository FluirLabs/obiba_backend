export const USDC_DECIMALS = 6;
export const UNCAPPED_USD = 10n ** 18n;
export const U128_MAX = (1n << 128n) - 1n;

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;
const BASE_UNITS = /^(0|[1-9]\d*)$/;

export class MoneyError extends Error {}

export function parseBaseUnits(value: string): bigint {
  if (typeof value !== 'string' || value.length > 39 || !BASE_UNITS.test(value)) {
    throw new MoneyError('amount must be a non-negative integer string of base units');
  }
  const n = BigInt(value);
  if (n > U128_MAX) throw new MoneyError('amount exceeds u128');
  return n;
}

export function parseDecimal(value: string, decimals: number): bigint {
  if (typeof value !== 'string' || value.length > 50 || !DECIMAL.test(value)) {
    throw new MoneyError('amount must be a plain decimal string');
  }
  const [whole = '0', frac = ''] = value.split('.');
  if (frac.length > decimals) throw new MoneyError(`amount has more than ${decimals} decimal places`);
  const n = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  if (n > U128_MAX) throw new MoneyError('amount exceeds u128');
  return n;
}

export function formatDecimal(units: bigint, decimals: number): string {
  if (units < 0n) throw new MoneyError('negative amount');
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  const frac = (units % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function assertPositive(units: bigint): bigint {
  if (units <= 0n) throw new MoneyError('amount must be positive');
  return units;
}

export function feeFor(amount: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new MoneyError('invalid fee bps');
  return (amount * BigInt(feeBps)) / 10_000n;
}

export function usdUnits(amount: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 24) throw new MoneyError('invalid token decimals');
  if (decimals <= USDC_DECIMALS) return amount * 10n ** BigInt(USDC_DECIMALS - decimals);
  const divisor = 10n ** BigInt(decimals - USDC_DECIMALS);
  return amount / divisor + (amount % divisor === 0n ? 0n : 1n);
}
