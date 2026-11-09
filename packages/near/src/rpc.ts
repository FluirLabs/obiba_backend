export class RpcError extends Error {
  constructor(
    message: string,
    readonly kind: 'transport' | 'rpc' | 'handler',
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface AccessKeyView {
  nonce: number;
  permission: 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
  block_hash: string;
  block_height: number;
}

export interface ExecutionOutcome {
  id: string;
  block_hash?: string;
  outcome: {
    logs: string[];
    receipt_ids: string[];
    executor_id: string;
    status: { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown } | string;
  };
}

export interface AccountView {
  amount: string;
  locked: string;
  storage_usage: number;
  code_hash: string;
  global_contract_hash?: string | null;
  global_contract_account_id?: string | null;
}

export interface FinalTxStatus {
  status: { SuccessValue?: string; Failure?: unknown } | string;
  transaction: { hash: string; signer_id: string; receiver_id: string };
  transaction_outcome: ExecutionOutcome;
  receipts_outcome: ExecutionOutcome[];
  final_execution_status?: string;
}

export class NearRpc {
  private id = 0;

  private rr = 0;

  private nextSlot = 0;
  private readonly coolUntil = new Map<string, number>();
  readonly stats = { requests: 0, rateLimited: 0, failovers: 0, errors: 0 };

  constructor(
    private readonly urls: string[],
    private readonly timeoutMs = 10_000,
    private readonly maxRps = 0,
  ) {
    if (urls.length === 0) throw new Error('at least one RPC url is required');
  }

  private async slot(): Promise<void> {
    if (this.maxRps <= 0) return;
    const now = Date.now();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + 1000 / this.maxRps;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }

  private cool(url: string): void {
    this.coolUntil.set(url, Date.now() + 3_000 + Math.random() * 4_000);
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    await this.slot();
    let last: unknown;
    const start = this.rr++ % this.urls.length;
    const now = Date.now();
    const order = this.urls.map((_, i) => this.urls[(start + i) % this.urls.length]!);
    const ready = order.filter((u) => (this.coolUntil.get(u) ?? 0) <= now);
    const cooling = order.filter((u) => (this.coolUntil.get(u) ?? 0) > now).sort((a, b) => this.coolUntil.get(a)! - this.coolUntil.get(b)!);
    if (ready.length === 0 && cooling[0]) await new Promise((r) => setTimeout(r, this.coolUntil.get(cooling[0]!)! - now));
    const candidates = [...ready, ...cooling];
    for (let i = 0; i < candidates.length; i++) {
      const url = candidates[i]!;
      let res: Response;
      this.stats.requests++;
      if (i > 0) this.stats.failovers++;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: `obiba-${++this.id}`, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'error',
        });
      } catch (err) {
        last = new RpcError(`rpc transport failed: ${(err as Error).name}`, 'transport');
        continue;
      }
      if (res.status === 429) {
        this.stats.rateLimited++;
        this.cool(url);
        last = new RpcError('rpc rate limited', 'transport');
        continue;
      }
      if (!res.ok && res.status >= 500) {
        last = new RpcError(`rpc status ${res.status}`, 'transport');
        continue;
      }
      const body = (await res.json().catch(() => null)) as { result?: T; error?: { name?: string; code?: number; message?: string; cause?: { name?: string }; data?: unknown } } | null;
      if (!body) {
        last = new RpcError('rpc returned invalid json', 'transport');
        continue;
      }
      if (body.error && (body.error.code === -429 || /rate.?limit|too many requests|deprecated/i.test(body.error.message ?? ''))) {
        this.stats.rateLimited++;
        this.cool(url);
        last = new RpcError('rpc rate limited', 'transport');
        continue;
      }
      if (body.error) {
        const name = body.error.cause?.name ?? body.error.name ?? 'UNKNOWN';
        throw new RpcError(name, body.error.name === 'HANDLER_ERROR' ? 'handler' : 'rpc', body.error.data);
      }
      const result = body.result as unknown;
      if (method === 'query' && result !== null && typeof result === 'object' && typeof (result as { error?: unknown }).error === 'string') {
        const msg = (result as { error: string }).error;
        const name = /access key .* does not exist/i.test(msg) ? 'UNKNOWN_ACCESS_KEY' : /account .* does not exist/i.test(msg) ? 'UNKNOWN_ACCOUNT' : 'QUERY_ERROR';
        throw new RpcError(name, 'handler', msg.slice(0, 300));
      }
      return result as T;
    }
    this.stats.errors++;
    throw last instanceof Error ? last : new RpcError('rpc unavailable', 'transport');
  }

  async blockHeight(blockHash: string): Promise<bigint> {
    const r = await this.call<{ header: { height: number } }>('block', { block_id: blockHash });
    return BigInt(r.header.height);
  }

  async finalBlock(): Promise<{ height: bigint; hash: string; timestampNs: bigint }> {
    const r = await this.call<{ header: { height: number; hash: string; timestamp_nanosec: string } }>('block', { finality: 'final' });
    return { height: BigInt(r.header.height), hash: r.header.hash, timestampNs: BigInt(r.header.timestamp_nanosec) };
  }

  async viewAccessKey(accountId: string, publicKey: string): Promise<AccessKeyView | null> {
    try {
      return await this.call<AccessKeyView>('query', {
        request_type: 'view_access_key',
        finality: 'final',
        account_id: accountId,
        public_key: publicKey,
      });
    } catch (err) {
      if (err instanceof RpcError && /UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT/.test(err.message)) return null;
      throw err;
    }
  }

  async viewAccount(accountId: string): Promise<AccountView> {
    return this.call<AccountView>('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
  }

  async accountExists(accountId: string): Promise<boolean> {
    try {
      await this.call('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
      return true;
    } catch (err) {
      if (err instanceof RpcError && /UNKNOWN_ACCOUNT/.test(err.message)) return false;
      throw err;
    }
  }

  async viewAccessKeyList(accountId: string): Promise<Array<{ public_key: string; access_key: { permission: AccessKeyView['permission'] } }>> {
    const r = await this.call<{ keys: Array<{ public_key: string; access_key: { permission: AccessKeyView['permission'] } }> }>('query', {
      request_type: 'view_access_key_list',
      finality: 'final',
      account_id: accountId,
    });
    return r.keys;
  }

  async view<T>(contractId: string, method: string, args: unknown, blockHeight?: bigint): Promise<T> {
    const r = await this.call<{ result: number[] }>('query', {
      request_type: 'call_function',
      ...(blockHeight === undefined ? { finality: 'final' } : { block_id: Number(blockHeight) }),
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    return JSON.parse(Buffer.from(r.result).toString()) as T;
  }

  async sendTx(signedTxBase64: string, waitUntil: 'INCLUDED_FINAL' | 'EXECUTED_OPTIMISTIC' | 'FINAL' = 'FINAL'): Promise<FinalTxStatus> {
    return this.call<FinalTxStatus>('send_tx', { signed_tx_base64: signedTxBase64, wait_until: waitUntil });
  }

  async txStatus(txHash: string, senderId: string): Promise<FinalTxStatus> {
    return this.call<FinalTxStatus>('EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: senderId, wait_until: 'FINAL' });
  }
}

export function isFailure(status: FinalTxStatus['status'] | ExecutionOutcome['outcome']['status']): boolean {
  return typeof status === 'object' && status !== null && 'Failure' in status;
}
