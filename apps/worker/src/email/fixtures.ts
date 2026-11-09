import type { EmailKind, EmailPayloads } from '@obiba/domain';
import type { Brand } from './design';

export const PREVIEW_BRAND: Brand = { appOrigin: 'https://app.obibajk.com', assetOrigin: 'https://app.obibajk.com', supportEmail: 'hello@obibajk.com' };
export const PREVIEW_LINK = 'https://app.obibajk.com/auth/action?mode=resetPassword&oobCode=preview-code-not-valid';

const at = '2026-11-09T14:32:00.000Z';
const deposit = { depositId: '7f3a91c4-2b1e-4c55-9d0a-1b2c3d4e5f60', origin: 'USDT on Tron', amount: '250', at };
const withdrawal = { withdrawalId: 'a14e0c77-58d2-4f19-8b36-9c0d1e2f3a4b', units: '120500000', decimals: 6, currency: 'USDC', destination: 'USDC on Base', recipient: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F', received: '120.32', at };

export interface Fixture<K extends EmailKind = EmailKind> {
  name: string;
  kind: K;
  data: EmailPayloads[K];
}

function f<K extends EmailKind>(name: string, kind: K, data: EmailPayloads[K]): Fixture {
  return { name, kind, data } as unknown as Fixture;
}

export const FIXTURES: Fixture[] = [
  f('welcome', 'WELCOME', {}),
  f('verify-email', 'VERIFY_EMAIL', {}),
  f('password-reset', 'PASSWORD_RESET', { device: 'Mac', browser: 'Chrome', at }),
  f('password-changed', 'PASSWORD_CHANGED', { at }),
  f('new-device', 'NEW_DEVICE', { device: 'iPhone', browser: 'Safari', ip: '154.160.21.8', at }),
  f('deposit-initiated', 'DEPOSIT_INITIATED', deposit),
  f('deposit-pending', 'DEPOSIT_PENDING', deposit),
  f('deposit-confirmed', 'DEPOSIT_CONFIRMED', { units: '249180000', decimals: 6, currency: 'USDC', reference: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', method: 'USDT on Tron', from: null, at }),
  f('deposit-confirmed-direct', 'DEPOSIT_CONFIRMED', { units: '1500000000', decimals: 6, currency: 'USDC', reference: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', method: 'Direct transfer on NEAR', from: 'ama-savings.near', at }),
  f('deposit-review', 'DEPOSIT_REVIEW', deposit),
  f('deposit-expired', 'DEPOSIT_FAILED', { ...deposit, reason: 'EXPIRED' }),
  f('deposit-refunding', 'DEPOSIT_FAILED', { ...deposit, reason: 'REFUNDING' }),
  f('deposit-refunded', 'DEPOSIT_FAILED', { ...deposit, reason: 'REFUNDED' }),
  f('deposit-failed', 'DEPOSIT_FAILED', { ...deposit, reason: 'FAILED' }),
  f('withdrawal-requested', 'WITHDRAWAL_REQUESTED', withdrawal),
  f('withdrawal-processing', 'WITHDRAWAL_PROCESSING', withdrawal),
  f('withdrawal-completed', 'WITHDRAWAL_COMPLETED', withdrawal),
  f('withdrawal-review', 'WITHDRAWAL_REVIEW', withdrawal),
  f('withdrawal-refunded', 'WITHDRAWAL_FAILED', { ...withdrawal, refunded: true }),
  f('withdrawal-failed', 'WITHDRAWAL_FAILED', { ...withdrawal, refunded: false }),
];
