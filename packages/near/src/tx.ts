import { createHash } from 'node:crypto';
import { PublicKey, SignedTransaction, actions, createTransaction, type Action } from 'near-api-js';
import { base58 } from '@scure/base';
import { decodeSignedDelegate } from './delegate';
import type { NearRpc } from './rpc';
import type { Signer } from './signer';

export interface NonceSource {
  next(accountId: string, publicKey: string, chainNonce: () => Promise<bigint>): Promise<bigint>;
  reset(accountId: string, publicKey: string): Promise<void>;
}

export class MemoryNonceSource implements NonceSource {
  private readonly nonces = new Map<string, bigint>();

  async next(accountId: string, publicKey: string, chainNonce: () => Promise<bigint>): Promise<bigint> {
    const key = `${accountId}:${publicKey}`;
    const current = this.nonces.get(key) ?? (await chainNonce());
    const next = current + 1n;
    this.nonces.set(key, next);
    return next;
  }

  async reset(accountId: string, publicKey: string): Promise<void> {
    this.nonces.delete(`${accountId}:${publicKey}`);
  }
}

export interface BuiltTx {
  hash: string;
  signedBase64: string;
}

export async function buildSignedTx(
  rpc: NearRpc,
  signer: Signer,
  nonces: NonceSource,
  signerId: string,
  receiverId: string,
  txActions: Action[],
): Promise<BuiltTx> {
  const publicKey = await signer.publicKey();
  const block = await rpc.finalBlock();
  const nonce = await nonces.next(signerId, publicKey, async () => {
    const key = await rpc.viewAccessKey(signerId, publicKey);
    if (!key) throw new Error(`signer key not found on ${signerId}`);
    return BigInt(key.nonce);
  });
  const tx = createTransaction(signerId, PublicKey.from(publicKey), receiverId, nonce, txActions, base58.decode(block.hash));
  const bytes = tx.encode();
  const hash = createHash('sha256').update(bytes).digest();
  const signature = await signer.sign(hash);
  const signed = new SignedTransaction({ transaction: tx, signature: { ed25519Signature: { data: signature } } as never });
  return { hash: base58.encode(hash), signedBase64: Buffer.from(signed.encode()).toString('base64') };
}

export function signedDelegateAction(signedDelegateBase64: string): Action {
  const decoded = decodeSignedDelegate(signedDelegateBase64);
  return actions.signedDelegate(decoded as never);
}

export { actions };
export type { Action };

export interface NonceStore {
  set(key: string, value: string, mode: 'NX'): Promise<'OK' | null>;
  incr(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

export class RedisNonceSource implements NonceSource {
  constructor(private readonly redis: NonceStore) {}

  async next(accountId: string, publicKey: string, chainNonce: () => Promise<bigint>): Promise<bigint> {
    const key = `nonce:${accountId}:${publicKey}`;
    await this.redis.set(key, (await chainNonce()).toString(), 'NX');
    return BigInt(await this.redis.incr(key));
  }

  async reset(accountId: string, publicKey: string): Promise<void> {
    await this.redis.del(`nonce:${accountId}:${publicKey}`);
  }
}
