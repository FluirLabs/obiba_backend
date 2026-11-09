import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { publishUserEvents, type EventPublisher } from '@obiba/domain';
import { DEFAULT_RELAY_METHODS, RpcError, buildSignedTx, checkRelayable, isFailure, signedDelegateAction, type NearRpc, type NonceSource, type Signer, type StorageSponsor } from '@obiba/near';
import type { Budget } from './core';

export interface CallConfig {
  relayerAccount: string;
  accountSuffix: string;
  maxGas: bigint;
  maxRelaysPerUserPerDay: number;
}

export class AccountCallRunner {
  constructor(
    private readonly pool: Pool,
    private readonly rpc: NearRpc,
    private readonly signer: Signer,
    private readonly nonces: NonceSource,
    private readonly budget: Budget,
    private readonly cfg: CallConfig,
    private readonly log: Logger,
    private readonly publisher: EventPublisher,
    private readonly sponsor: StorageSponsor,
  ) {}

  async run(callId: string): Promise<'settled' | 'failed' | 'skipped' | 'unknown'> {
    const call = (
      await this.pool.query<{ uid: string; account_id: string; method: string; status: string; signed_delegate: string | null }>(
        'select uid, account_id, method, status, signed_delegate from ops.account_calls where call_id = $1',
        [callId],
      )
    ).rows[0];
    if (!call || call.status !== 'SUBMITTED' || !call.signed_delegate) return 'skipped';
    const check = checkRelayable(call.signed_delegate, { accountSuffix: this.cfg.accountSuffix, allowedMethods: DEFAULT_RELAY_METHODS, maxGas: this.cfg.maxGas });
    if (!check.ok || check.sender !== call.account_id || check.method !== call.method) return this.finish(callId, call.uid, 'FAILED', check.ok ? 'mismatch' : check.reason);
    const day = new Date().toISOString().slice(0, 10);
    if (!(await this.budget.take(`relay:${call.uid}:${day}`, this.cfg.maxRelaysPerUserPerDay, 172_800))) return this.finish(callId, call.uid, 'FAILED', 'relay_budget');
    await this.sponsor.ensure(call.account_id, call.method);
    const tx = await buildSignedTx(this.rpc, this.signer, this.nonces, this.cfg.relayerAccount, call.account_id, [signedDelegateAction(call.signed_delegate)]);
    await this.pool.query('update ops.account_calls set tx_hash = $2, updated_at = now() where call_id = $1', [callId, tx.hash]);
    let status;
    try {
      status = await this.rpc.sendTx(tx.signedBase64, 'FINAL');
    } catch (err) {
      if (err instanceof RpcError && /InvalidNonce|INVALID_TRANSACTION/.test(err.message)) {
        await this.nonces.reset(this.cfg.relayerAccount, await this.signer.publicKey());
        throw err;
      }
      this.log.warn({ call: callId, tx: tx.hash }, 'account call outcome unknown');
      return 'unknown';
    }
    const ok = !isFailure(status.status) && status.receipts_outcome.every((r) => !isFailure(r.outcome.status));
    return this.finish(callId, call.uid, ok ? 'SETTLED' : 'FAILED', ok ? undefined : 'chain_rejected');
  }

  private async finish(callId: string, uid: string, status: 'SETTLED' | 'FAILED', reason?: string): Promise<'settled' | 'failed'> {
    await this.pool.query("update ops.account_calls set status = $2, reason = $3, updated_at = now() where call_id = $1 and status = 'SUBMITTED'", [callId, status, reason ?? null]);
    await publishUserEvents(this.publisher, [{ uid, kind: 'account', id: callId, status: `CALL_${status}` }]);
    return status === 'SETTLED' ? 'settled' : 'failed';
  }
}
