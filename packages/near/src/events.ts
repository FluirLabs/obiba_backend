export interface FtTransferEvent {
  logIndex: number;
  oldOwnerId: string;
  newOwnerId: string;
  amount: bigint;
  memo: string | null;
}

const EVENT_PREFIX = 'EVENT_JSON:';
const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const AMOUNT = /^(0|[1-9]\d{0,38})$/;

export function parseFtTransfers(logs: readonly string[]): FtTransferEvent[] {
  const out: FtTransferEvent[] = [];
  logs.forEach((log, logIndex) => {
    if (typeof log !== 'string' || !log.startsWith(EVENT_PREFIX) || log.length > 16_384) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(log.slice(EVENT_PREFIX.length));
    } catch {
      return;
    }
    const e = parsed as { standard?: unknown; event?: unknown; data?: unknown };
    if (e.standard !== 'nep141' || e.event !== 'ft_transfer' || !Array.isArray(e.data)) return;
    for (const item of e.data as Array<Record<string, unknown>>) {
      const oldOwner = item?.old_owner_id;
      const newOwner = item?.new_owner_id;
      const amount = item?.amount;
      if (typeof oldOwner !== 'string' || !ACCOUNT.test(oldOwner)) continue;
      if (typeof newOwner !== 'string' || !ACCOUNT.test(newOwner)) continue;
      if (typeof amount !== 'string' || !AMOUNT.test(amount)) continue;
      const value = BigInt(amount);
      if (value === 0n) continue;
      const memo = typeof item.memo === 'string' ? item.memo.slice(0, 256) : null;
      out.push({ logIndex, oldOwnerId: oldOwner, newOwnerId: newOwner, amount: value, memo });
    }
  });
  return out;
}
