import { isFailure, RpcError, type NearRpc } from './rpc';

export interface ReceiptOutcome {
  receiptId: string;
  executorId: string;
  logs: string[];
  failed: boolean;
  txHash: string | null;
}

export interface BlockOutcomes {
  height: bigint;
  outcomes: ReceiptOutcome[];
}

export interface BlockSource {
  finalHeight(): Promise<bigint>;
  block(height: bigint): Promise<BlockOutcomes | null>;
}

const MAX_BLOCK_BYTES = 20 * 1024 * 1024;

const MAX_BACKOFF_MS = 30_000;

export class NeardataSource implements BlockSource {
  private nextAt = 0;
  private backoffMs = 0;
  readonly stats = { requests: 0, rateLimited: 0 };

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 20_000,
    private readonly minIntervalMs = 0,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly apiKey: string | null = null,
  ) {
    if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) throw new Error('neardata URL must be https');
  }

  private async request(path: string, redirect: 'manual' | 'error'): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await this.sleep(wait);
      const url = this.apiKey ? `${this.baseUrl}${path}${path.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(this.apiKey)}` : `${this.baseUrl}${path}`;
      this.stats.requests++;
      const res = await fetch(url, { redirect, headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}, signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status !== 429 || attempt >= 5) {
        if (res.status !== 429) this.backoffMs = 0;
        this.nextAt = Date.now() + this.minIntervalMs;
        return res;
      }
      this.stats.rateLimited++;
      const retryAfter = Number(res.headers.get('retry-after'));
      this.backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS) : Math.min(Math.max(this.backoffMs * 2, 1000), MAX_BACKOFF_MS);
      this.nextAt = Date.now() + this.backoffMs;
    }
  }

  async finalHeight(): Promise<bigint> {
    const res = await this.request('/v0/last_block/final', 'manual');
    const location = res.headers.get('location') ?? '';
    const m = /\/v0\/block\/(\d{1,20})(?:\?.*)?$/.exec(location);
    if (!m) throw new Error(`unexpected neardata final-block response ${res.status}`);
    return BigInt(m[1]!);
  }

  async block(height: bigint): Promise<BlockOutcomes | null> {
    const res = await this.request(`/v0/block/${height}`, 'error');
    if (!res.ok) throw new Error(`neardata status ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BLOCK_BYTES) throw new Error('neardata block too large');
    if (text.trim() === 'null') return null;
    return parseNeardataBlock(JSON.parse(text) as unknown);
  }
}

interface NeardataReo {
  execution_outcome?: { id?: string; outcome?: { executor_id?: string; logs?: unknown; status?: unknown } };
  tx_hash?: string | null;
}

export function parseNeardataBlock(raw: unknown): BlockOutcomes {
  const d = raw as { block?: { header?: { height?: number } }; shards?: Array<{ receipt_execution_outcomes?: NeardataReo[] }> };
  const height = d.block?.header?.height;
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || !Array.isArray(d.shards)) throw new Error('invalid neardata block');
  const outcomes: ReceiptOutcome[] = [];
  for (const shard of d.shards) {
    for (const reo of shard.receipt_execution_outcomes ?? []) {
      const id = reo.execution_outcome?.id;
      const out = reo.execution_outcome?.outcome;
      if (typeof id !== 'string' || !out || typeof out.executor_id !== 'string' || !Array.isArray(out.logs)) continue;
      outcomes.push({
        receiptId: id,
        executorId: out.executor_id,
        logs: out.logs.filter((l): l is string => typeof l === 'string'),
        failed: isFailure(out.status as never),
        txHash: typeof reo.tx_hash === 'string' ? reo.tx_hash : null,
      });
    }
  }
  return { height: BigInt(height), outcomes };
}

export class RpcBlockSource implements BlockSource {
  constructor(private readonly rpc: NearRpc) {}

  async finalHeight(): Promise<bigint> {
    return (await this.rpc.finalBlock()).height;
  }

  async block(height: bigint): Promise<BlockOutcomes | null> {
    let block: { chunks: Array<{ chunk_hash: string; height_included: number }> };
    try {
      block = await this.rpc.call('block', { block_id: Number(height) });
    } catch (err) {
      if (err instanceof RpcError && /UNKNOWN_BLOCK/.test(err.message)) return null;
      throw err;
    }
    const outcomes: ReceiptOutcome[] = [];
    for (const c of block.chunks) {
      if (BigInt(c.height_included) !== height) continue;
      const chunk = await this.rpc.call<{ transactions: Array<{ hash: string; signer_id: string }> }>('chunk', { chunk_id: c.chunk_hash });
      for (const tx of chunk.transactions) {
        const status = await this.rpc.txStatus(tx.hash, tx.signer_id);
        for (const r of status.receipts_outcome) {
          outcomes.push({ receiptId: r.id, executorId: r.outcome.executor_id, logs: r.outcome.logs, failed: isFailure(r.outcome.status), txHash: tx.hash });
        }
      }
    }
    return { height, outcomes };
  }
}

export class FilteredBlockSource implements BlockSource {
  private readonly pending = new Map<bigint, Promise<boolean | null>>();
  private final: { height: bigint; at: number } | null = null;

  constructor(
    private readonly rpc: NearRpc,
    private readonly inner: BlockSource,
    private readonly watch: (accountId: string) => boolean,
    private readonly window = 8,
    private readonly finalTtlMs = 1_500,
    private readonly tipMargin = 5n,
  ) {}

  async finalHeight(): Promise<bigint> {
    if (this.final && Date.now() - this.final.at < this.finalTtlMs) return this.final.height;
    const height = (await this.rpc.finalBlock()).height;
    this.final = { height, at: Date.now() };
    return height;
  }

  private relevant(height: bigint): Promise<boolean | null> {
    let p = this.pending.get(height);
    if (!p) {
      p = this.rpc.call<{ changes: Array<{ account_id?: string }> }>('EXPERIMENTAL_changes_in_block', { block_id: Number(height) }).then(
        (r) => r.changes.some((c) => typeof c.account_id === 'string' && this.watch(c.account_id)),
        (err: unknown) => {
          if (err instanceof RpcError && /UNKNOWN_BLOCK/.test(err.message)) return null;
          throw err;
        },
      );
      p.catch(() => undefined);
      this.pending.set(height, p);
    }
    return p;
  }

  async block(height: bigint): Promise<BlockOutcomes | null> {
    for (let i = 0n; i < BigInt(this.window); i++) void this.relevant(height + i);
    for (const h of this.pending.keys()) if (h < height) this.pending.delete(h);
    let hit: boolean | null;
    try {
      hit = await this.relevant(height);
    } catch (err) {
      this.pending.delete(height);
      throw err;
    }
    this.pending.delete(height);
    if (hit === false) return { height, outcomes: [] };
    if (hit === null && this.final && height + this.tipMargin > this.final.height) throw new Error(`block ${height} is not yet known to the RPC endpoint; retrying`);
    const full = await this.inner.block(height);
    if (hit === true && full === null) throw new Error(`block ${height} touched a watched account but its full data is missing`);
    return full;
  }
}
