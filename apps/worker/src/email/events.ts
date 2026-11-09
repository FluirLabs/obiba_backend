import { z } from 'zod';
import type { EmailKind, EmailPayloads } from '@obiba/domain';

const decimal = z.string().regex(/^\d{1,30}(\.\d{1,24})?$/);
const units = z.string().regex(/^[1-9]\d{0,38}$/);
const iso = z.string().datetime();
const label = z.string().min(1).max(80).regex(/^[^\r\n]+$/);
const nullableLabel = label.nullable();
const decimals = z.number().int().min(0).max(24);
const uuid = z.string().uuid();

const deposit = z.object({ depositId: uuid, origin: label, amount: decimal.nullable(), at: iso });
const withdrawal = z.object({ withdrawalId: uuid, units, decimals, currency: label, destination: label, recipient: z.string().min(2).max(100), received: decimal.nullable(), at: iso });

export const EMAIL_SCHEMAS: { [K in EmailKind]: z.ZodType<EmailPayloads[K]> } = {
  WELCOME: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  VERIFY_EMAIL: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  PASSWORD_RESET: z.object({ device: nullableLabel, browser: nullableLabel, at: iso }),
  PASSWORD_CHANGED: z.object({ at: iso }),
  NEW_DEVICE: z.object({ device: nullableLabel, browser: nullableLabel, ip: z.string().min(2).max(45).nullable(), at: iso }),
  DEPOSIT_INITIATED: deposit,
  DEPOSIT_PENDING: deposit,
  DEPOSIT_CONFIRMED: z.object({ units, decimals, currency: label, reference: z.string().min(8).max(100), method: label, from: z.string().min(2).max(100).nullable(), at: iso }),
  DEPOSIT_REVIEW: deposit,
  DEPOSIT_FAILED: deposit.extend({ reason: z.enum(['EXPIRED', 'REFUNDING', 'REFUNDED', 'FAILED']) }),
  WITHDRAWAL_REQUESTED: withdrawal,
  WITHDRAWAL_PROCESSING: withdrawal,
  WITHDRAWAL_COMPLETED: withdrawal,
  WITHDRAWAL_REVIEW: withdrawal,
  WITHDRAWAL_FAILED: withdrawal.extend({ refunded: z.boolean() }),
};

export function isEmailKind(kind: string): kind is EmailKind {
  return Object.prototype.hasOwnProperty.call(EMAIL_SCHEMAS, kind);
}

export const LINK_KINDS = new Set<EmailKind>(['PASSWORD_RESET', 'VERIFY_EMAIL']);
export const CRITICAL_KINDS = new Set<string>(['PASSWORD_RESET', 'PASSWORD_CHANGED', 'VERIFY_EMAIL', 'NEW_DEVICE']);
export const LINK_MAX_AGE_MS = 30 * 60 * 1000;
