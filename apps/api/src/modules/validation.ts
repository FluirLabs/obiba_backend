import { z } from 'zod';
import { MoneyError, isNearAccountId, parseDecimal } from '@obiba/domain';
import { appError } from '../errors';

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

export const displayName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((v) => !CONTROL.test(v), 'control characters are not allowed');

export const handle = z.string().regex(/^[a-z0-9_]{3,24}$/);
export const nearAccount = z.string().refine(isNearAccountId, 'invalid NEAR account');
export const reference = z.string().max(64).refine((v) => !CONTROL.test(v));

export function ghanaPhone(raw: string): string {
  const compact = raw.replace(/[\s-]/g, '');
  let local: string | null = null;
  if (/^0\d{9}$/.test(compact)) local = compact.slice(1);
  else if (/^233\d{9}$/.test(compact)) local = compact.slice(3);
  else if (/^\+233\d{9}$/.test(compact)) local = compact.slice(4);
  if (!local || local.startsWith('0')) throw appError('BAD_INPUT', 'phone');
  return `+233${local}`;
}

export function amount(value: string, decimals: number, max: bigint, field = 'amount'): bigint {
  let units: bigint;
  try {
    units = parseDecimal(value, decimals);
  } catch (err) {
    if (err instanceof MoneyError) throw appError('BAD_INPUT', field);
    throw err;
  }
  if (units <= 0n || units > max) throw appError('BAD_INPUT', field);
  return units;
}

export function parse<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw appError('BAD_INPUT', field);
  return r.data;
}
