import { PublicKey, actions, type Action } from 'near-api-js';
import type { NearRpc } from './rpc';

export const DEVICE_METHODS = [
  'execute',
  'pay_invoice',
  'set_limit',
  'cancel_recovery',
  'unfreeze',
  'add_device',
  'remove_device',
  'propose_guardian',
  'rotate_guardian',
  'add_token',
  'disable_token',
];

export interface ProvisionParams {
  accountId: string;
  devicePublicKey: string;
  guardianPublicKey: string;
  payContract: string;
  networkId: string;
  tokens: Array<{ token: string; decimals: number }>;
  dailyLimitUsd: bigint;
  maxOpAmountUsd: bigint;
  fundingYocto: bigint;
  deviceAllowanceYocto: bigint;
  code: { codeHash: Uint8Array } | { wasm: Uint8Array };
}

export function provisionActions(p: ProvisionParams): Action[] {
  const code = 'codeHash' in p.code ? actions.useGlobalContract({ codeHash: p.code.codeHash }) : actions.deployContract(p.code.wasm);
  return [
    actions.createAccount(),
    actions.transfer(p.fundingYocto),
    code,
    actions.addFunctionCallAccessKey(PublicKey.from(p.devicePublicKey), p.accountId, DEVICE_METHODS, p.deviceAllowanceYocto),
    actions.functionCall(
      'new',
      {
        tokens: p.tokens,
        pay_contract: p.payContract,
        network_id: p.networkId,
        guardian: p.guardianPublicKey,
        device: p.devicePublicKey,
        daily_limit: p.dailyLimitUsd.toString(),
        max_op_amount: p.maxOpAmountUsd.toString(),
      },
      50_000_000_000_000n,
      0n,
    ),
  ];
}

export type ProvisionCheck = { ok: true } | { ok: false; reason: string };

export type ExpectedCode = { globalCodeHash: string } | { codeHash: string };

export async function verifyProvisioned(rpc: NearRpc, accountId: string, devicePublicKey: string, code: ExpectedCode): Promise<ProvisionCheck> {
  const account = await rpc.viewAccount(accountId);
  if ('globalCodeHash' in code) {
    if (account.global_contract_hash !== code.globalCodeHash) return { ok: false, reason: 'account does not use the expected global contract' };
  } else if (account.code_hash !== code.codeHash || account.global_contract_hash) {
    return { ok: false, reason: 'account code hash' };
  }
  const keys = await rpc.viewAccessKeyList(accountId);
  if (keys.length !== 1) return { ok: false, reason: `expected exactly one key, found ${keys.length}` };
  const [key] = keys;
  if (key!.public_key !== devicePublicKey) return { ok: false, reason: 'unexpected key' };
  const perm = key!.access_key.permission;
  if (perm === 'FullAccess' || !('FunctionCall' in perm)) return { ok: false, reason: 'device key has full access' };
  if (perm.FunctionCall.receiver_id !== accountId) return { ok: false, reason: 'device key receiver' };
  const methods = new Set(perm.FunctionCall.method_names);
  if (methods.size !== DEVICE_METHODS.length || DEVICE_METHODS.some((m) => !methods.has(m))) return { ok: false, reason: 'device key methods' };
  return { ok: true };
}
