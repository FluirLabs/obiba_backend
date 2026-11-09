import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { actions, buildSignedTx, isFailure, YOCTO_PER_BYTE, type NearRpc, type NonceSource, type Signer } from '@obiba/near';

export const PAY_FLOAT_LOW_WATER_YOCTO = 50n * 10n ** 21n;
export const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
const PRUNE_GAS = 100_000_000_000_000n;
const PRUNED_AT_KEY = 'pay:pruned_at';

export function payFloat(view: { amount: string; storage_usage: number }): bigint {
  return BigInt(view.amount) - BigInt(view.storage_usage) * YOCTO_PER_BYTE;
}

export function shouldPrune(float: bigint, lastPrunedMs: number, nowMs: number): boolean {
  return float < PAY_FLOAT_LOW_WATER_YOCTO || nowMs - lastPrunedMs >= PRUNE_EVERY_MS;
}

export class PayPruner {
  constructor(
    private readonly rpc: NearRpc,
    private readonly signer: Signer,
    private readonly nonces: NonceSource,
    private readonly relayerAccount: string,
    private readonly payContract: string,
    private readonly redis: Redis,
    private readonly log: Logger,
  ) {}

  async tick(nowMs = Date.now()): Promise<'pruned' | 'skipped'> {
    const float = payFloat(await this.rpc.viewAccount(this.payContract));
    const last = Number((await this.redis.get(PRUNED_AT_KEY)) ?? 0);
    if (!shouldPrune(float, last, nowMs)) return 'skipped';
    const tx = await buildSignedTx(this.rpc, this.signer, this.nonces, this.relayerAccount, this.payContract, [actions.functionCall('prune', { max: 100 }, PRUNE_GAS, 0n)]);
    const status = await this.rpc.sendTx(tx.signedBase64, 'FINAL');
    if (isFailure(status.status)) throw new Error('obiba-pay prune failed');
    await this.redis.set(PRUNED_AT_KEY, String(nowMs));
    const after = payFloat(await this.rpc.viewAccount(this.payContract));
    if (after < PAY_FLOAT_LOW_WATER_YOCTO) this.log.warn({ payContract: this.payContract, floatYocto: after.toString() }, 'obiba-pay storage float is low; top it up');
    return 'pruned';
  }
}
