import { isObibaUserAccount } from '@obiba/domain';
import { decodeSignedDelegate } from './delegate';

export interface RelayPolicy {
  accountSuffix: string;
  allowedMethods: ReadonlySet<string>;
  maxGas: bigint;
}

export const DEFAULT_RELAY_METHODS = new Set(['execute', 'pay_invoice', 'set_limit', 'cancel_recovery', 'add_token', 'disable_token', 'add_device', 'remove_device']);

export type RelayCheck = { ok: true; sender: string; method: string } | { ok: false; reason: string };

export function checkRelayable(signedDelegateBase64: string, policy: RelayPolicy): RelayCheck {
  let d;
  try {
    d = decodeSignedDelegate(signedDelegateBase64).delegateAction;
  } catch {
    return { ok: false, reason: 'undecodable' };
  }
  if (!policy.accountSuffix.startsWith('.') || !isObibaUserAccount(d.senderId, policy.accountSuffix.slice(1))) return { ok: false, reason: 'sender_not_obiba' };
  if (d.receiverId !== d.senderId) return { ok: false, reason: 'receiver' };
  if (d.actions.length !== 1) return { ok: false, reason: 'action_count' };
  const call = (d.actions[0] as { functionCall?: { methodName: string; gas: bigint; deposit: bigint } }).functionCall;
  if (!call) return { ok: false, reason: 'action_type' };
  if (!policy.allowedMethods.has(call.methodName)) return { ok: false, reason: 'method' };
  if (BigInt(call.deposit) !== 0n) return { ok: false, reason: 'deposit' };
  if (BigInt(call.gas) > policy.maxGas) return { ok: false, reason: 'gas' };
  return { ok: true, sender: d.senderId, method: call.methodName };
}
