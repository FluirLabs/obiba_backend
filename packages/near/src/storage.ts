import { actions } from 'near-api-js';
import type { AccountView, NearRpc } from './rpc';
import { isFailure } from './rpc';
import { buildSignedTx, type NonceSource } from './tx';
import type { Signer } from './signer';

export const ZERO_BALANCE_LIMIT_BYTES = 770n;
export const YOCTO_PER_BYTE = 10n ** 19n;
export const STORAGE_MARGIN_BYTES = 128n;
export const MAX_TOP_UP_YOCTO = 50n * 10n ** 21n;

const HEADROOM: Record<string, bigint> = {
  add_device: 400n,
  add_token: 120n,
  begin_recovery: 64n,
  propose_guardian: 64n,
  set_limit: 48n,
  execute: 64n,
  pay_invoice: 64n,
};

export function headroomFor(method: string | undefined): bigint {
  return (method === undefined ? undefined : HEADROOM[method]) ?? 32n;
}

export function storageTopUp(view: Pick<AccountView, 'amount' | 'locked' | 'storage_usage'>, headroom: bigint): bigint {
  const projected = BigInt(view.storage_usage) + headroom;
  if (projected <= ZERO_BALANCE_LIMIT_BYTES) return 0n;
  const needed = (projected + STORAGE_MARGIN_BYTES) * YOCTO_PER_BYTE;
  const have = BigInt(view.amount) + BigInt(view.locked);
  return needed > have ? needed - have : 0n;
}

export class StorageSponsor {
  constructor(
    private readonly rpc: NearRpc,
    private readonly signer: Signer,
    private readonly nonces: NonceSource,
    private readonly sponsorAccount: string,
  ) {}

  async ensure(accountId: string, method: string | undefined): Promise<bigint> {
    const amount = storageTopUp(await this.rpc.viewAccount(accountId), headroomFor(method));
    if (amount === 0n) return 0n;
    if (amount > MAX_TOP_UP_YOCTO) throw new Error(`storage top-up for ${accountId} exceeds the per-call cap`);
    const tx = await buildSignedTx(this.rpc, this.signer, this.nonces, this.sponsorAccount, accountId, [actions.transfer(amount)]);
    const status = await this.rpc.sendTx(tx.signedBase64, 'FINAL');
    if (isFailure(status.status)) throw new Error(`storage top-up for ${accountId} failed`);
    return amount;
  }
}
