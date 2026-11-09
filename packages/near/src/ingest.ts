import { parseFtTransfers } from './events';
import { isFailure, type FinalTxStatus } from './rpc';

export interface TransferEvent {
  receiptId: string;
  logIndex: number;
  token: string;
  from: string;
  to: string;
  amount: bigint;
  memo: string | null;
  txHash?: string | null;
  blockHash?: string | null;
}

export interface ObibaEvent {
  receiptId: string;
  logIndex: number;
  emitter: string;
  event: string;
  data: Record<string, unknown>;
  txHash?: string | null;
}

const OBIBA_EVENTS = new Set([
  'op_submitted',
  'op_executed',
  'op_failed',
  'invoice_paid',
  'invoice_rejected',
  'forward_failed',
  'recovery_started',
  'recovery_completed',
  'frozen',
  'guardian_change_proposed',
  'token_enabled',
  'paused',
]);

export interface IngestScope {
  tokens: ReadonlySet<string>;
  isObibaEmitter(accountId: string): boolean;
}

export interface OutcomeLike {
  receiptId: string;
  executorId: string;
  logs: string[];
  failed: boolean;
  txHash?: string | null;
  blockHash?: string | null;
}

export function extractEvents(status: FinalTxStatus, scope: IngestScope): { transfers: TransferEvent[]; obiba: ObibaEvent[] } {
  return extractFromOutcomes(
    status.receipts_outcome.map((r) => ({
      receiptId: r.id,
      executorId: r.outcome.executor_id,
      logs: r.outcome.logs,
      failed: isFailure(r.outcome.status),
      txHash: status.transaction?.hash ?? null,
      blockHash: r.block_hash ?? null,
    })),
    scope,
  );
}

export function extractFromOutcomes(outcomes: readonly OutcomeLike[], scope: IngestScope): { transfers: TransferEvent[]; obiba: ObibaEvent[] } {
  const transfers: TransferEvent[] = [];
  const obiba: ObibaEvent[] = [];
  for (const r of outcomes) {
    if (r.failed) continue;
    const executor = r.executorId;
    if (scope.tokens.has(executor)) {
      for (const t of parseFtTransfers(r.logs)) {
        transfers.push({
          receiptId: r.receiptId,
          logIndex: t.logIndex,
          token: executor,
          from: t.oldOwnerId,
          to: t.newOwnerId,
          amount: t.amount,
          memo: t.memo,
          txHash: r.txHash ?? null,
          blockHash: r.blockHash ?? null,
        });
      }
    }
    if (scope.isObibaEmitter(executor)) {
      r.logs.forEach((log, logIndex) => {
        if (!log.startsWith('EVENT_JSON:') || log.length > 16_384) return;
        try {
          const e = JSON.parse(log.slice('EVENT_JSON:'.length)) as { standard?: string; event?: string; data?: unknown[] };
          if (e.standard !== 'obiba' || typeof e.event !== 'string' || !OBIBA_EVENTS.has(e.event) || !Array.isArray(e.data)) return;
          const data = e.data[0];
          if (data && typeof data === 'object') obiba.push({ receiptId: r.receiptId, logIndex, emitter: executor, event: e.event, data: data as Record<string, unknown>, txHash: r.txHash ?? null });
        } catch {
          return;
        }
      });
    }
  }
  return { transfers, obiba };
}
