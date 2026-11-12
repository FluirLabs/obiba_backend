import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';

export interface AccountPolicy {
  invoice_payer_binding?: boolean;
  tokens?: Array<{ token: string; decimals: number; enabled: boolean }>;
  guardian?: string;
  guardian_nonce?: string;
  devices?: string[];
  effective_daily_limit: string;
  daily_limit: string;
  max_op_amount: string;
  spent_24h: string;
  frozen_until_ns: string;
  pending_limit: { new_limit: string; effective_at_ns: string } | null;
  recovery: { new_key: string; executable_at_ns: string } | null;
}

export class UnknownEntityError extends Error {}

export abstract class NearChain {
  async supportsRestrictedInvoices(_accountId: string): Promise<boolean> { return false; }
  abstract finalBlockHeight(): Promise<bigint>;
  abstract policy(accountId: string): Promise<AccountPolicy>;
  abstract storageRegistered(token: string, accountId: string): Promise<boolean>;
  abstract accessKeyNonce(accountId: string, publicKey: string): Promise<bigint | null>;
  abstract tokenBalance(token: string, accountId: string): Promise<bigint>;
  abstract payTokens(): Promise<string[]>;
}

@Injectable()
export class RpcNearChain extends NearChain {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    let lastError: unknown;
    for (const url of this.config.NEAR_RPC_URLS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'obiba', method, params }),
          signal: AbortSignal.timeout(5_000),
          redirect: 'error',
        });
        if (!res.ok) throw new Error(`rpc status ${res.status}`);
        const body = (await res.json()) as { result?: T & { error?: unknown }; error?: { cause?: { name?: string } } };
        if (body.error !== undefined) {
          const name = body.error?.cause?.name ?? 'RPC_ERROR';
          if (/^UNKNOWN_/.test(name)) throw new UnknownEntityError(name);
          throw new Error(name);
        }
        if (body.result === undefined) throw new Error('RPC_ERROR');
        if (typeof body.result === 'object' && body.result !== null && 'error' in body.result && body.result.error) throw new UnknownEntityError('QUERY_ERROR');
        return body.result;
      } catch (err) {
        if (err instanceof UnknownEntityError) throw err;
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('rpc unavailable');
  }

  private async view<T>(contractId: string, method: string, args: unknown): Promise<T> {
    const r = await this.rpc<{ result?: number[] }>('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    if (!Array.isArray(r.result) || r.result.length > 64_000) throw new Error('bad view result');
    return JSON.parse(Buffer.from(r.result).toString()) as T;
  }

  async finalBlockHeight(): Promise<bigint> {
    const r = await this.rpc<{ header?: { height?: number } }>('block', { finality: 'final' });
    const height = r.header?.height;
    if (typeof height !== 'number' || !Number.isSafeInteger(height) || height <= 0) throw new Error('bad rpc response');
    return BigInt(height);
  }

  async policy(accountId: string): Promise<AccountPolicy> {
    return this.view<AccountPolicy>(accountId, 'get_policy', {});
  }

  async accessKeyNonce(accountId: string, publicKey: string): Promise<bigint | null> {
    try {
      const r = await this.rpc<{ nonce?: number | string }>('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
      return r.nonce === undefined ? null : BigInt(r.nonce);
    } catch (err) {
      if (err instanceof UnknownEntityError) return null;
      throw err;
    }
  }

  async tokenBalance(token: string, accountId: string): Promise<bigint> {
    const r = await this.view<unknown>(token, 'ft_balance_of', { account_id: accountId });
    if (typeof r !== 'string' || !/^\d{1,39}$/.test(r)) throw new Error('bad balance');
    return BigInt(r);
  }

  async payTokens(): Promise<string[]> {
    const r = await this.view<{ tokens?: unknown }>(this.config.PAY_CONTRACT, 'get_config', {});
    return Array.isArray(r.tokens) ? r.tokens.filter((t): t is string => typeof t === 'string') : [];
  }

  override async supportsRestrictedInvoices(accountId: string): Promise<boolean> {
    const [config, policy] = await Promise.all([
      this.view<{ invoice_payer_binding?: boolean }>(this.config.PAY_CONTRACT, 'get_config', {}),
      this.policy(accountId),
    ]);
    return config.invoice_payer_binding === true && policy.invoice_payer_binding === true;
  }

  async storageRegistered(token: string, accountId: string): Promise<boolean> {
    const r = await this.view<{ total?: string } | null>(token, 'storage_balance_of', { account_id: accountId });
    return r !== null && typeof r === 'object' && typeof r.total === 'string';
  }
}
