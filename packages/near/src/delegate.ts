import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'borsh';
import { PublicKey, SCHEMA, actions, buildDelegateAction, encodeDelegateAction } from 'near-api-js';
import { ed25519KeyBytes, ed25519KeyString, verifyEd25519 } from '@obiba/domain';

export const MAX_SIGNED_DELEGATE_BYTES = 8 * 1024;

interface RawFunctionCall {
  methodName: string;
  args: Uint8Array | number[];
  gas: bigint;
  deposit: bigint;
}

interface RawDelegateAction {
  senderId: string;
  receiverId: string;
  actions: Array<Record<string, unknown>>;
  nonce: bigint;
  maxBlockHeight: bigint;
  publicKey: { ed25519Key?: { data: number[] | Uint8Array } } & Record<string, unknown>;
}

interface RawSignedDelegate {
  delegateAction: RawDelegateAction;
  signature: { ed25519Signature?: { data: number[] | Uint8Array } } & Record<string, unknown>;
}

export interface ExpectedCall {
  account: string;
  methodName: string;
  args: Uint8Array;
  devicePublicKeys: string[];
  maxGas: bigint;
  currentBlockHeight: bigint;
  maxBlockHeightWindow: bigint;
}

export type DelegateCheck =
  | { ok: true; delegateHash: string; nonce: bigint; maxBlockHeight: bigint; publicKey: string }
  | { ok: false; reason: string };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function decodeSignedDelegate(base64: string): RawSignedDelegate {
  if (typeof base64 !== 'string' || base64.length > Math.ceil((MAX_SIGNED_DELEGATE_BYTES * 4) / 3) + 4) {
    throw new Error('signed delegate too large');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('signed delegate is not base64');
  const bytes = Buffer.from(base64, 'base64');
  return deserialize(SCHEMA.SignedDelegate, bytes) as RawSignedDelegate;
}

export function checkSignedDelegate(base64: string, expected: ExpectedCall): DelegateCheck {
  let signed: RawSignedDelegate;
  try {
    signed = decodeSignedDelegate(base64);
  } catch {
    return { ok: false, reason: 'undecodable' };
  }
  const d = signed.delegateAction;
  if (d.senderId !== expected.account) return { ok: false, reason: 'sender' };
  if (d.receiverId !== expected.account) return { ok: false, reason: 'receiver' };
  if (d.actions.length !== 1) return { ok: false, reason: 'action_count' };
  const call = (d.actions[0] as { functionCall?: RawFunctionCall }).functionCall;
  if (!call) return { ok: false, reason: 'action_type' };
  if (call.methodName !== expected.methodName) return { ok: false, reason: 'method' };
  if (!bytesEqual(Uint8Array.from(call.args), expected.args)) return { ok: false, reason: 'args' };
  if (BigInt(call.deposit) !== 0n) return { ok: false, reason: 'deposit' };
  if (BigInt(call.gas) > expected.maxGas) return { ok: false, reason: 'gas' };
  const maxBlockHeight = BigInt(d.maxBlockHeight);
  if (maxBlockHeight <= expected.currentBlockHeight) return { ok: false, reason: 'expired' };
  if (maxBlockHeight > expected.currentBlockHeight + expected.maxBlockHeightWindow) return { ok: false, reason: 'expiry_too_far' };
  const keyData = d.publicKey.ed25519Key?.data;
  if (!keyData) return { ok: false, reason: 'key_type' };
  if (keyData.length !== 32) return { ok: false, reason: 'key_type' };
  const publicKey = ed25519KeyString(Uint8Array.from(keyData));
  const known = expected.devicePublicKeys.some((k) => {
    try {
      return bytesEqual(ed25519KeyBytes(k), Uint8Array.from(keyData));
    } catch {
      return false;
    }
  });
  if (!known) return { ok: false, reason: 'unknown_key' };
  const sig = signed.signature.ed25519Signature?.data;
  if (!sig) return { ok: false, reason: 'signature_type' };
  const hash = createHash('sha256').update(encodeDelegateAction(d as never)).digest();
  if (!verifyEd25519(publicKey, hash, Uint8Array.from(sig))) return { ok: false, reason: 'signature' };
  return { ok: true, delegateHash: hash.toString('hex'), nonce: BigInt(d.nonce), maxBlockHeight, publicKey };
}

export interface UnsignedDelegate {
  delegateBase64: string;
  signingHashHex: string;
  nonce: bigint;
  maxBlockHeight: bigint;
}

export function buildUnsignedDelegate(p: {
  account: string;
  methodName: string;
  args: Uint8Array;
  gas: bigint;
  nonce: bigint;
  maxBlockHeight: bigint;
  publicKey: string;
}): UnsignedDelegate {
  ed25519KeyBytes(p.publicKey);
  const delegate = buildDelegateAction({
    senderId: p.account,
    receiverId: p.account,
    actions: [actions.functionCall(p.methodName, p.args, p.gas, 0n)],
    nonce: p.nonce,
    maxBlockHeight: p.maxBlockHeight,
    publicKey: PublicKey.from(p.publicKey),
  });
  const hash = createHash('sha256').update(encodeDelegateAction(delegate)).digest();
  const bytes = serialize(SCHEMA.DelegateAction, delegate);
  return { delegateBase64: Buffer.from(bytes).toString('base64'), signingHashHex: hash.toString('hex'), nonce: p.nonce, maxBlockHeight: p.maxBlockHeight };
}

export function assembleSignedDelegate(delegateBase64: string, signatureBase64: string): string {
  const delegate = Buffer.from(delegateBase64, 'base64');
  const signature = Buffer.from(signatureBase64, 'base64');
  if (signature.length !== 64) throw new Error('ed25519 signature must be 64 bytes');
  return Buffer.concat([delegate, Buffer.from([0]), signature]).toString('base64');
}
