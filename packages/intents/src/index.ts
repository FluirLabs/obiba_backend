import { quoteHash, verifyQuoteSignature } from '@defuse-protocol/one-click-sdk-typescript';

export { quoteHash };
import { keccak_256 } from '@noble/hashes/sha3';
import { base58 } from '@scure/base';
import { createHash } from 'node:crypto';
import type { states } from '@obiba/domain';

export interface OriginAsset {
  key: string;
  label: string;
  chain: 'tron' | 'evm' | 'solana' | 'near';
  assetId: string;
  signedAssetIds: string[];
  decimals: number;
  minUsd: number;
}

export const MAINNET_ORIGINS: OriginAsset[] = [
  { key: 'USDT_TRON', label: 'USDT on Tron', chain: 'tron', assetId: 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near', signedAssetIds: ['nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near'], decimals: 6, minUsd: 5 },
  { key: 'USDT_BSC', label: 'USDT on BNB Chain', chain: 'evm', assetId: 'nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g', signedAssetIds: ['nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g'], decimals: 18, minUsd: 5 },
  { key: 'USDC_BASE', label: 'USDC on Base', chain: 'evm', assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', signedAssetIds: ['nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'], decimals: 6, minUsd: 2 },
  { key: 'USDC_ARB', label: 'USDC on Arbitrum', chain: 'evm', assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', signedAssetIds: ['nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near'], decimals: 6, minUsd: 2 },
  { key: 'SOL', label: 'SOL on Solana', chain: 'solana', assetId: 'nep141:sol.omft.near', signedAssetIds: ['nep141:sol.omft.near'], decimals: 9, minUsd: 5 },
  { key: 'USDC_SOL', label: 'USDC on Solana', chain: 'solana', assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', signedAssetIds: ['nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near'], decimals: 6, minUsd: 2 },
];

export class OneClickError extends Error {
  constructor(
    message: string,
    readonly code: 'ONECLICK_UNAVAILABLE' | 'AMOUNT_BELOW_MINIMUM' | 'ROUTE_UNSUPPORTED' | 'RECIPIENT_INVALID',
    readonly minimum?: string,
  ) {
    super(message);
  }
}

export interface QuoteRequest {
  dry: boolean;
  swapType: 'FLEX_INPUT' | 'EXACT_INPUT' | 'EXACT_OUTPUT';
  slippageTolerance: number;
  originAsset: string;
  depositType: 'ORIGIN_CHAIN';
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: 'ORIGIN_CHAIN';
  recipient: string;
  recipientType: 'DESTINATION_CHAIN';
  deadline: string;
  customRecipientMsg?: string;
  appFees?: Array<{ recipient: string; fee: number }>;
}

export interface QuoteResponse {
  quote: Record<string, string | number | undefined>;
  quoteRequest: Record<string, unknown>;
  signature: string;
  timestamp: string;
  correlationId?: string;
}

export class OneClickClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly timeoutMs = 30_000,
  ) {
    if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) throw new Error('1Click base URL must be https');
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'Obiba/1.0',
          ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw new OneClickError('conversion service unavailable', 'ONECLICK_UNAVAILABLE');
    }
    const text = await res.text();
    if (text.length > 1_000_000) throw new OneClickError('conversion service response too large', 'ONECLICK_UNAVAILABLE');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status >= 400) {
      const message = String((json as { message?: unknown } | null)?.message ?? '').slice(0, 300);
      if (res.status >= 500 || [401, 403, 429].includes(res.status)) throw new OneClickError('conversion service unavailable', 'ONECLICK_UNAVAILABLE');
      const min = /try at least (\d+)/.exec(message)?.[1];
      if (min) throw new OneClickError('amount below minimum', 'AMOUNT_BELOW_MINIMUM', min);
      if (/recipient|refund|address|trustline/i.test(message)) throw new OneClickError('address rejected', 'RECIPIENT_INVALID');
      throw new OneClickError('route unsupported', 'ROUTE_UNSUPPORTED');
    }
    if (json === null) throw new OneClickError('conversion service returned invalid json', 'ONECLICK_UNAVAILABLE');
    return json as T;
  }

  quote(body: QuoteRequest): Promise<QuoteResponse> {
    return this.request('POST', '/v0/quote', body);
  }

  status(depositAddress: string, depositMemo?: string | null): Promise<OneClickStatus> {
    const q = new URLSearchParams({ depositAddress, ...(depositMemo ? { depositMemo } : {}) });
    return this.request('GET', `/v0/status?${q.toString()}`);
  }
}

export interface OneClickStatus {
  status: string;
  swapDetails?: {
    destinationChainTxHashes?: Array<{ hash: string }>;
    originChainTxHashes?: Array<{ hash: string }>;
    amountOut?: string;
    refundedAmount?: string;
    refundReason?: string;
  };
}

export const ONECLICK_QUOTE_KEY = 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';

export type QuoteCheck = { ok: true } | { ok: false; reason: string };

export function checkSignedQuote(
  res: QuoteResponse,
  sent: Partial<QuoteRequest>,
  origin: Pick<OriginAsset, 'signedAssetIds'>,
  publicKey: string = ONECLICK_QUOTE_KEY,
  options: { dry?: boolean } = {},
): QuoteCheck {
  let valid = false;
  try {
    valid = verifyQuoteSignature(res as never, publicKey);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'signature' };
  const signed = res.quoteRequest;
  for (const field of ['dry', 'swapType', 'destinationAsset', 'amount', 'refundTo', 'refundType', 'recipient', 'recipientType', 'depositType', 'customRecipientMsg'] as const) {
    if (sent[field] !== undefined && signed[field] !== sent[field]) return { ok: false, reason: `field:${field}` };
  }
  if (!origin.signedAssetIds.includes(String(signed.originAsset))) return { ok: false, reason: 'field:originAsset' };
  if (!options.dry && !res.quote.depositAddress) return { ok: false, reason: 'no_deposit_address' };
  return { ok: true };
}

export function depositState(oneClickStatus: string): states.DepositState | null {
  switch (oneClickStatus) {
    case 'PENDING_DEPOSIT':
      return 'AWAITING_DEPOSIT';
    case 'KNOWN_DEPOSIT_TX':
      return 'DETECTED';
    case 'PROCESSING':
      return 'CONVERTING';
    case 'INCOMPLETE_DEPOSIT':
      return 'INCOMPLETE';
    case 'SUCCESS':
      return 'VERIFYING_SETTLEMENT';
    case 'REFUNDED':
      return 'REFUNDED';
    case 'FAILED':
      return 'REVIEW_REQUIRED';
    default:
      return null;
  }
}

function evmChecksumOk(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const hash = Buffer.from(keccak_256(new TextEncoder().encode(body.toLowerCase()))).toString('hex');
  return [...body].every((ch, i) => (/[a-f]/i.test(ch) ? (parseInt(hash[i]!, 16) >= 8 ? ch === ch.toUpperCase() : ch === ch.toLowerCase()) : true));
}

function tronOk(address: string): boolean {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  let raw: Uint8Array;
  try {
    raw = base58.decode(address);
  } catch {
    return false;
  }
  if (raw.length !== 25 || raw[0] !== 0x41) return false;
  const body = raw.slice(0, 21);
  const check = createHash('sha256').update(createHash('sha256').update(body).digest()).digest().subarray(0, 4);
  return Buffer.compare(Buffer.from(raw.slice(21)), check) === 0;
}

function solanaOk(address: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  try {
    return base58.decode(address).length === 32;
  } catch {
    return false;
  }
}

export function validRefundAddress(chain: OriginAsset['chain'], address: string): boolean {
  if (typeof address !== 'string' || address.length > 100) return false;
  switch (chain) {
    case 'evm':
      return evmChecksumOk(address);
    case 'tron':
      return tronOk(address);
    case 'solana':
      return solanaOk(address);
    case 'near':
      return /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(address);
  }
}

export interface DestinationAsset {
  key: string;
  label: string;
  chain: 'evm';
  network: string;
  assetId: string;
  tokenAddress: string;
  decimals: number;
  confirmations: number;
}

export const MAINNET_DESTINATIONS: DestinationAsset[] = [
  {
    key: 'USDC_BASE',
    label: 'USDC on Base',
    chain: 'evm',
    network: 'base',
    assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    tokenAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    decimals: 6,
    confirmations: 10,
  },
  {
    key: 'USDC_ARB',
    label: 'USDC on Arbitrum',
    chain: 'evm',
    network: 'arbitrum',
    assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    tokenAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    decimals: 6,
    confirmations: 10,
  },
];

export function parseDestinations(json: string): DestinationAsset[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed) || parsed.length > 16) throw new Error('destinations must be an array of at most 16 entries');
  return parsed.map((d) => {
    const x = d as Partial<DestinationAsset>;
    if (typeof x.key !== 'string' || !/^[A-Z0-9_]{2,32}$/.test(x.key)) throw new Error('invalid destination key');
    if (typeof x.label !== 'string' || x.label.length < 2 || x.label.length > 64) throw new Error('invalid destination label');
    if (x.chain !== 'evm') throw new Error('only evm destinations are supported');
    if (typeof x.network !== 'string' || !/^[a-z0-9-]{2,32}$/.test(x.network)) throw new Error('invalid destination network');
    if (typeof x.assetId !== 'string' || !/^nep(141|245):[a-z0-9._:-]{2,128}$/i.test(x.assetId)) throw new Error('invalid destination asset');
    if (typeof x.tokenAddress !== 'string' || !/^0x[0-9a-f]{40}$/.test(x.tokenAddress)) throw new Error('destination token address must be lowercase hex');
    if (!Number.isInteger(x.decimals) || x.decimals! < 0 || x.decimals! > 24) throw new Error('invalid destination decimals');
    if (!Number.isInteger(x.confirmations) || x.confirmations! < 1 || x.confirmations! > 1000) throw new Error('invalid destination confirmations');
    return x as DestinationAsset;
  });
}

export function withdrawalState(oneClickStatus: string): states.WithdrawalState | null {
  switch (oneClickStatus) {
    case 'PROCESSING':
      return 'PROCESSING';
    case 'SUCCESS':
      return 'VERIFYING';
    case 'REFUNDED':
      return 'REFUNDED';
    case 'FAILED':
    case 'INCOMPLETE_DEPOSIT':
      return 'REVIEW_REQUIRED';
    default:
      return null;
  }
}

export function invoiceDepositState(oneClickStatus: string): states.InvoiceDepositState | null {
  switch (oneClickStatus) {
    case 'PENDING_DEPOSIT':
      return 'AWAITING_DEPOSIT';
    case 'KNOWN_DEPOSIT_TX':
      return 'DETECTED';
    case 'PROCESSING':
      return 'CONVERTING';
    case 'INCOMPLETE_DEPOSIT':
      return 'INCOMPLETE';
    case 'SUCCESS':
      return 'DELIVERED';
    case 'REFUNDED':
      return 'REFUNDED';
    case 'FAILED':
      return 'REVIEW_REQUIRED';
    default:
      return null;
  }
}

export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export type EvmTransferCheck =
  | { ok: true; amount: bigint; blockNumber: bigint }
  | { ok: false; reason: 'not_found' | 'confirmations' | 'reverted' | 'transfer_count' | 'amount' | 'rpc'; final: boolean };

interface EvmReceipt {
  status?: string;
  blockNumber?: string;
  logs?: Array<{ address?: string; topics?: string[]; data?: string; removed?: boolean }>;
}

export class EvmRpc {
  private id = 0;

  constructor(
    private readonly url: string,
    private readonly timeoutMs = 10_000,
  ) {
    if (!/^https:\/\//.test(url) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('EVM RPC URL must be https');
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`evm rpc status ${res.status}`);
    const text = await res.text();
    if (text.length > 2_000_000) throw new Error('evm rpc response too large');
    const body = JSON.parse(text) as { result?: T; error?: unknown };
    if (body.error !== undefined) throw new Error('evm rpc error');
    return body.result as T;
  }
}

const HEX_QUANTITY = /^0x[0-9a-f]{1,64}$/i;

export async function verifyEvmTransfer(
  rpc: Pick<EvmRpc, 'call'>,
  check: { txHash: string; token: string; recipient: string; minAmount: bigint; confirmations: number },
): Promise<EvmTransferCheck> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(check.txHash)) return { ok: false, reason: 'not_found', final: true };
  let receipt: EvmReceipt | null;
  let head: string;
  try {
    receipt = await rpc.call<EvmReceipt | null>('eth_getTransactionReceipt', [check.txHash]);
    head = await rpc.call<string>('eth_blockNumber', []);
  } catch {
    return { ok: false, reason: 'rpc', final: false };
  }
  if (!receipt) return { ok: false, reason: 'not_found', final: false };
  if (receipt.status !== '0x1') return { ok: false, reason: 'reverted', final: true };
  if (!HEX_QUANTITY.test(receipt.blockNumber ?? '') || !HEX_QUANTITY.test(head)) return { ok: false, reason: 'rpc', final: false };
  const block = BigInt(receipt.blockNumber!);
  if (BigInt(head) - block + 1n < BigInt(check.confirmations)) return { ok: false, reason: 'confirmations', final: false };
  const token = check.token.toLowerCase();
  const recipient = check.recipient.toLowerCase().replace(/^0x/, '');
  const matches = (receipt.logs ?? []).filter(
    (l) =>
      !l.removed &&
      l.address?.toLowerCase() === token &&
      l.topics?.length === 3 &&
      l.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC &&
      /^0x0{24}[0-9a-f]{40}$/i.test(l.topics[2] ?? '') &&
      l.topics[2]!.slice(-40).toLowerCase() === recipient,
  );
  if (matches.length !== 1) return { ok: false, reason: 'transfer_count', final: true };
  const data = matches[0]!.data ?? '';
  if (!HEX_QUANTITY.test(data)) return { ok: false, reason: 'transfer_count', final: true };
  const amount = BigInt(data);
  if (amount < check.minAmount) return { ok: false, reason: 'amount', final: true };
  return { ok: true, amount, blockNumber: block };
}
