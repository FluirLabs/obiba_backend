import { RpcError } from './rpc';

export interface TxHint {
  hash: string;
  height: number;
}

const HASH = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const ACCOUNT = /^[a-z0-9._-]{2,64}$/;
const MAX_BODY = 2_000_000;

export const TX_INDEX_URLS: Record<string, string> = {
  mainnet: 'https://tx.main.fastnear.com',
  testnet: 'https://tx.test.fastnear.com',
};

export class FastNearTxIndex {
  readonly stats = { requests: 0, rateLimited: 0, errors: 0 };

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    this.stats.requests++;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      this.stats.errors++;
      throw new RpcError('tx index unreachable', 'transport');
    }
    if (res.status === 429) {
      this.stats.rateLimited++;
      throw new RpcError('tx index rate limited', 'transport', { status: 429 });
    }
    const text = await res.text();
    if (!res.ok || text.length > MAX_BODY) {
      this.stats.errors++;
      throw new RpcError(`tx index responded ${res.status}`, 'transport', { status: res.status });
    }
    return JSON.parse(text) as T;
  }

  async accountTxs(accountId: string, sinceHeight: number, maxPages = 5): Promise<TxHint[]> {
    if (!ACCOUNT.test(accountId)) throw new Error('invalid account id');
    const out: TxHint[] = [];
    let max: number | null = null;
    for (let page = 0; page < maxPages; page++) {
      const body = await this.post<{ account_txs?: unknown }>('/v0/account', max === null ? { account_id: accountId } : { account_id: accountId, max_block_height: max });
      const rows = Array.isArray(body.account_txs) ? body.account_txs : [];
      let lowest = Infinity;
      for (const r of rows as Array<Record<string, unknown>>) {
        const hash = r.transaction_hash;
        const height = r.tx_block_height;
        if (typeof hash !== 'string' || !HASH.test(hash) || typeof height !== 'number' || !Number.isSafeInteger(height)) continue;
        lowest = Math.min(lowest, height);
        if (height > sinceHeight && r.is_success !== false) out.push({ hash, height });
      }
      if (rows.length === 0 || lowest <= sinceHeight || !Number.isFinite(lowest)) break;
      max = lowest - 1;
    }
    return [...new Map(out.map((h) => [h.hash, h])).values()];
  }

  async signers(hashes: string[]): Promise<Map<string, string>> {
    const wanted = hashes.filter((h) => HASH.test(h));
    const out = new Map<string, string>();
    for (let i = 0; i < wanted.length; i += 20) {
      const body = await this.post<{ transactions?: unknown }>('/v0/transactions', { tx_hashes: wanted.slice(i, i + 20) });
      for (const t of (Array.isArray(body.transactions) ? body.transactions : []) as Array<{ transaction?: { hash?: unknown; signer_id?: unknown } }>) {
        const hash = t?.transaction?.hash;
        const signer = t?.transaction?.signer_id;
        if (typeof hash === 'string' && typeof signer === 'string' && wanted.includes(hash) && ACCOUNT.test(signer)) out.set(hash, signer);
      }
    }
    return out;
  }
}
