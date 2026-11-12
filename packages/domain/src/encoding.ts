import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { serialize, type Schema } from 'borsh';
import { base58 } from '@scure/base';

export const ACCOUNT_TAG = 'obiba-account/v1';
export const INVOICE_TAG = 'obiba-invoice/v1';
export const DEVICE_OP_TAG = 'obiba-device-op/v1';

export type OpKind = 'Transfer' | 'PayInvoice';
export const PURPOSES = [
  'ExecuteOp',
  'RaiseLimit',
  'AddDevice',
  'RemoveDevice',
  'BeginRecovery',
  'Freeze',
  'Unfreeze',
  'RotateGuardian',
  'VetoGuardianChange',
  'AddToken',
] as const;
export type Purpose = (typeof PURPOSES)[number];

export interface Op {
  op_id: string;
  kind: OpKind;
  token: string;
  receiver: string;
  amount: string;
  expires_at_ns: string;
  memo: string | null;
}

export interface Invoice {
  invoice_id: string;
  merchant: string;
  token: string;
  amount: string;
  fee_bps: number;
  expires_at_ns: string;
  reference: string | null;
  payer?: string | null;
}

export interface KeyPayload {
  public_key: string;
  guardian_nonce: string;
}
export interface LimitPayload {
  new_limit: string;
  guardian_nonce: string;
}
export interface FreezePayload {
  until_ns: string;
  guardian_nonce: string;
}
export interface TokenPayload {
  token: string;
  decimals: number;
  guardian_nonce: string;
}
export interface NoncePayload {
  guardian_nonce: string;
}

const unitEnum = (names: readonly string[]): Schema => ({
  enum: names.map((n) => ({ struct: { [n]: { struct: {} } } })),
});

const OP_SCHEMA: Schema = {
  struct: {
    op_id: 'string',
    kind: unitEnum(['Transfer', 'PayInvoice']),
    token: 'string',
    receiver: 'string',
    amount: 'u128',
    expires_at_ns: 'u64',
    memo: { option: 'string' },
  },
};

const INVOICE_SCHEMA: Schema = {
  struct: {
    invoice_id: 'string',
    merchant: 'string',
    token: 'string',
    amount: 'u128',
    fee_bps: 'u16',
    expires_at_ns: 'u64',
    reference: { option: 'string' },
  },
};

const PUBLIC_KEY_SCHEMA: Schema = { array: { type: 'u8' } };
const KEY_PAYLOAD_SCHEMA: Schema = { struct: { public_key: PUBLIC_KEY_SCHEMA, guardian_nonce: 'u64' } };
const LIMIT_PAYLOAD_SCHEMA: Schema = { struct: { new_limit: 'u128', guardian_nonce: 'u64' } };
const FREEZE_PAYLOAD_SCHEMA: Schema = { struct: { until_ns: 'u64', guardian_nonce: 'u64' } };
const NONCE_PAYLOAD_SCHEMA: Schema = { struct: { guardian_nonce: 'u64' } };
const TOKEN_PAYLOAD_SCHEMA: Schema = { struct: { token: 'string', decimals: 'u8', guardian_nonce: 'u64' } };

const GUARDIAN_ENVELOPE_SCHEMA: Schema = {
  struct: {
    tag: 'string',
    network_id: 'string',
    account: 'string',
    purpose: unitEnum(PURPOSES),
    payload: { array: { type: 'u8' } },
  },
};

const INVOICE_ENVELOPE_SCHEMA: Schema = {
  struct: { tag: 'string', network_id: 'string', pay_contract: 'string', invoice: INVOICE_SCHEMA },
};

export class EncodingError extends Error {}

export function ed25519KeyBytes(key: string): Uint8Array {
  if (typeof key !== 'string' || !key.startsWith('ed25519:')) throw new EncodingError('expected an ed25519: key');
  let raw: Uint8Array;
  try {
    raw = base58.decode(key.slice('ed25519:'.length));
  } catch {
    throw new EncodingError('invalid base58 key');
  }
  if (raw.length !== 32) throw new EncodingError('ed25519 public key must be 32 bytes');
  return raw;
}

export function ed25519KeyString(raw: Uint8Array): string {
  if (raw.length !== 32) throw new EncodingError('ed25519 public key must be 32 bytes');
  return `ed25519:${base58.encode(raw)}`;
}

function nearPublicKeyBytes(key: string): number[] {
  return [0, ...ed25519KeyBytes(key)];
}

function enumValue(name: string): Record<string, Record<string, never>> {
  return { [name]: {} };
}

function opValue(op: Op) {
  return {
    op_id: op.op_id,
    kind: enumValue(op.kind),
    token: op.token,
    receiver: op.receiver,
    amount: BigInt(op.amount),
    expires_at_ns: BigInt(op.expires_at_ns),
    memo: op.memo,
  };
}

function invoiceValue(invoice: Invoice) {
  return {
    invoice_id: invoice.invoice_id,
    merchant: invoice.merchant,
    token: invoice.token,
    amount: BigInt(invoice.amount),
    fee_bps: invoice.fee_bps,
    expires_at_ns: BigInt(invoice.expires_at_ns),
    reference: invoice.reference,
  };
}

export function opBytes(op: Op): Uint8Array {
  return serialize(OP_SCHEMA, opValue(op));
}

export type GuardianPayload =
  | { purpose: 'ExecuteOp'; payload: Op }
  | { purpose: 'RaiseLimit'; payload: LimitPayload }
  | { purpose: 'AddDevice' | 'RemoveDevice' | 'BeginRecovery' | 'RotateGuardian' | 'VetoGuardianChange'; payload: KeyPayload }
  | { purpose: 'Freeze'; payload: FreezePayload }
  | { purpose: 'Unfreeze'; payload: NoncePayload }
  | { purpose: 'AddToken'; payload: TokenPayload };

function payloadBytes(p: GuardianPayload): Uint8Array {
  switch (p.purpose) {
    case 'ExecuteOp':
      return opBytes(p.payload);
    case 'RaiseLimit':
      return serialize(LIMIT_PAYLOAD_SCHEMA, {
        new_limit: BigInt(p.payload.new_limit),
        guardian_nonce: BigInt(p.payload.guardian_nonce),
      });
    case 'Freeze':
      return serialize(FREEZE_PAYLOAD_SCHEMA, {
        until_ns: BigInt(p.payload.until_ns),
        guardian_nonce: BigInt(p.payload.guardian_nonce),
      });
    case 'Unfreeze':
      return serialize(NONCE_PAYLOAD_SCHEMA, { guardian_nonce: BigInt(p.payload.guardian_nonce) });
    case 'AddToken':
      if (!Number.isInteger(p.payload.decimals) || p.payload.decimals < 0 || p.payload.decimals > 24) {
        throw new EncodingError('token decimals must be 0..24');
      }
      return serialize(TOKEN_PAYLOAD_SCHEMA, {
        token: p.payload.token,
        decimals: p.payload.decimals,
        guardian_nonce: BigInt(p.payload.guardian_nonce),
      });
    default:
      return serialize(KEY_PAYLOAD_SCHEMA, {
        public_key: nearPublicKeyBytes(p.payload.public_key),
        guardian_nonce: BigInt(p.payload.guardian_nonce),
      });
  }
}

function envelope(tag: string, networkId: string, account: string, p: GuardianPayload): Uint8Array {
  return serialize(GUARDIAN_ENVELOPE_SCHEMA, {
    tag,
    network_id: networkId,
    account,
    purpose: enumValue(p.purpose),
    payload: Array.from(payloadBytes(p)),
  });
}

export function guardianPreimage(networkId: string, account: string, p: GuardianPayload): Uint8Array {
  return envelope(ACCOUNT_TAG, networkId, account, p);
}

export function deviceOpPreimage(networkId: string, account: string, op: Op): Uint8Array {
  return envelope(DEVICE_OP_TAG, networkId, account, { purpose: 'ExecuteOp', payload: op });
}

export function invoicePreimage(networkId: string, payContract: string, invoice: Invoice): Uint8Array {
  const preimage = serialize(INVOICE_ENVELOPE_SCHEMA, {
    tag: invoice.payer ? 'obiba-invoice/v2' : INVOICE_TAG,
    network_id: networkId,
    pay_contract: payContract,
    invoice: invoiceValue(invoice),
  });
  return invoice.payer ? Buffer.concat([preimage, serialize('string', invoice.payer)]) : preimage;
}

export function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

export function verifyEd25519(publicKey: string, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  let raw: Uint8Array;
  try {
    raw = ed25519KeyBytes(publicKey);
  } catch {
    return false;
  }
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') },
    format: 'jwk',
  });
  return nodeVerify(null, message, key, signature);
}

export function recoveryKitRegistrationMessage(networkId: string, accountId: string, kitPublicKey: string): Uint8Array {
  return new TextEncoder().encode(`obiba:recovery-kit:v1:${networkId}:${accountId}:${kitPublicKey}`);
}

export function recoveryKitChallenge(networkId: string, accountId: string, newDevicePublicKey: string, guardianNonce: string): Uint8Array {
  return new TextEncoder().encode(`obiba:recovery:v1:${networkId}:${accountId}:${newDevicePublicKey}:${guardianNonce}`);
}
