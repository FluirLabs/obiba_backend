import type { AppConfig } from '../config';
import type { NearChain } from '../infra/near-chain';
import { appError } from '../errors';

const PAY_TOKENS_TTL_MS = 60_000;
let payTokensCache: { at: number; tokens: string[] } | null = null;

export function usdcContracts(config: AppConfig): string[] {
  return [config.USDC_CONTRACT, ...config.USDC_LEGACY_CONTRACTS];
}

export async function enabledTokens(chain: NearChain, accountId: string): Promise<Set<string>> {
  try {
    const p = await chain.policy(accountId);
    return new Set((p.tokens ?? []).filter((t) => t.enabled).map((t) => t.token));
  } catch {
    throw appError('SERVICE_PAUSED');
  }
}

export async function spendToken(chain: NearChain, config: AppConfig, accountId: string, units: bigint, accepted?: string[]): Promise<string> {
  const candidates = usdcContracts(config).filter((t) => !accepted || accepted.includes(t));
  if (candidates.length === 0) throw appError('SERVICE_PAUSED');
  if (candidates.length === 1) return candidates[0]!;
  const enabled = await enabledTokens(chain, accountId);
  const usable = candidates.filter((t) => enabled.has(t));
  for (const t of usable) {
    let balance: bigint;
    try {
      balance = await chain.tokenBalance(t, accountId);
    } catch {
      throw appError('SERVICE_PAUSED');
    }
    if (balance >= units) return t;
  }
  return usable[0] ?? candidates[0]!;
}

export async function invoiceToken(chain: NearChain, config: AppConfig): Promise<string> {
  if (config.USDC_LEGACY_CONTRACTS.length === 0) return config.USDC_CONTRACT;
  if (!payTokensCache || Date.now() - payTokensCache.at > PAY_TOKENS_TTL_MS) {
    try {
      payTokensCache = { at: Date.now(), tokens: await chain.payTokens() };
    } catch {
      throw appError('SERVICE_PAUSED');
    }
  }
  const accepted = payTokensCache.tokens;
  const token = usdcContracts(config).find((t) => accepted.includes(t));
  if (!token) throw appError('SERVICE_PAUSED');
  return token;
}

export async function tokensToEnable(chain: NearChain, config: AppConfig, accountId: string): Promise<string[]> {
  if (config.USDC_LEGACY_CONTRACTS.length === 0) return [];
  const enabled = await enabledTokens(chain, accountId);
  return usdcContracts(config).filter((t) => !enabled.has(t));
}
