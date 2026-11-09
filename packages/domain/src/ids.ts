import { randomBytes } from 'node:crypto';

const HEX_ID = /^[0-9a-f]{32}$/;
const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function newHexId(): string {
  return randomBytes(16).toString('hex');
}

export function isHexId(value: unknown): value is string {
  return typeof value === 'string' && HEX_ID.test(value);
}

export function isNearAccountId(value: unknown): value is string {
  return typeof value === 'string' && NEAR_ACCOUNT.test(value);
}
