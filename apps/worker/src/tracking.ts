import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { randomInt } from 'node:crypto';
import { settleSandboxOp, withTx } from '@obiba/db';
import { TOPICS, emailJob, enqueueEmail, publishUserEvents, states, type EventPublisher, type TypedEmailJob } from '@obiba/domain';
import {
  invoiceDepositState,
  verifyEvmTransfer,
  withdrawalState,
  type DestinationAsset,
  type EvmRpc,
  type OneClickClient,
} from '@obiba/intents';
import { swapHashes } from './core';

const ACTIVE_WITHDRAWALS = ['PREPARED', 'SUBMITTED', 'SENT', 'PROCESSING', 'VERIFYING'];
const ACTIVE_INVOICE_PAYMENTS = ['AWAITING_DEPOSIT', 'DETECTED', 'CONVERTING', 'DELIVERED', 'INCOMPLETE', 'REFUND_PENDING'];
const VERIFY_TIMEOUT_MINUTES = 60;
const DELIVERY_TIMEOUT_MINUTES = 30;
const DEADLINE_GRACE_MS = 15 * 60 * 1000;

interface WithdrawalRow {
  id: string;
  uid: string;
  status: states.WithdrawalState;
  deposit_address: string;
  destination: string;
  recipient: string;
  min_amount_out: string;
  tx_hashes: { destination?: string[]; near?: string; origin?: string[] };
  stale: boolean;
  op_status: string;
  op_expired: boolean;
  relay_tx_hashes: string[];
  amount_in: string;
  amount_out_formatted: string | null;
}

const USDC_DECIMALS = 6;
const UNCOMMITTED_FAILURES = new Set(['not_signed', 'op_expired']);

export function withdrawalEmail(w: Pick<WithdrawalRow, 'id' | 'uid' | 'status' | 'destination' | 'recipient' | 'amount_in' | 'amount_out_formatted'>, to: states.WithdrawalState, label: string, evidence?: Record<string, unknown>, at = new Date().toISOString()): TypedEmailJob | null {
  const facts = { withdrawalId: w.id, units: w.amount_in, decimals: USDC_DECIMALS, currency: 'USDC', destination: label, recipient: w.recipient, received: w.amount_out_formatted && /^\d{1,30}(\.\d{1,24})?$/.test(w.amount_out_formatted) ? w.amount_out_formatted : null, at };
  const target = { uid: w.uid };
  switch (to) {
    case 'SENT':
    case 'PROCESSING':
      return emailJob('WITHDRAWAL_PROCESSING', target, `withdrawal:${w.id}:PROCESSING`, facts);
    case 'COMPLETED':
      return emailJob('WITHDRAWAL_COMPLETED', target, `withdrawal:${w.id}:COMPLETED`, facts);
    case 'REVIEW_REQUIRED':
      return emailJob('WITHDRAWAL_REVIEW', target, `withdrawal:${w.id}:REVIEW`, facts);
    case 'REFUNDED':
      return emailJob('WITHDRAWAL_FAILED', target, `withdrawal:${w.id}:REFUNDED`, { ...facts, refunded: true });
    case 'FAILED':
      if (w.status === 'PREPARED' && UNCOMMITTED_FAILURES.has(String(evidence?.reason))) return null;
      return emailJob('WITHDRAWAL_FAILED', target, `withdrawal:${w.id}:FAILED`, { ...facts, refunded: false });
    default:
      return null;
  }
}

export class WithdrawalTracker {
  private readonly destinations: Map<string, DestinationAsset>;

  constructor(
    private readonly pool: Pool,
    private readonly oneclick: Pick<OneClickClient, 'status'>,
    destinations: DestinationAsset[],
    private readonly evm: Map<string, Pick<EvmRpc, 'call'>>,
    private readonly log: Logger,
    private readonly publisher: EventPublisher,
  ) {
    this.destinations = new Map(destinations.map((d) => [d.key, d]));
  }

  async trackBatch(limit = 25): Promise<number> {
    const rows = (
      await this.pool.query<WithdrawalRow>(
        `select w.id, w.uid, w.status, w.deposit_address, w.destination, w.recipient, w.min_amount_out, w.tx_hashes, w.amount_in::text, w.quote->'quote'->>'amountOutFormatted' as amount_out_formatted,
                w.updated_at < now() - make_interval(mins => $2) as stale,
                p.status as op_status, p.expires_at_ns < (extract(epoch from now()) * 1000000000)::numeric as op_expired, p.relay_tx_hashes
           from ops.withdrawals w join ops.prepared_ops p on p.op_id = w.op_id
          where w.status = any($1) order by w.updated_at limit $3`,
        [ACTIVE_WITHDRAWALS, VERIFY_TIMEOUT_MINUTES, limit],
      )
    ).rows;
    let moved = 0;
    for (const w of rows) {
      try {
        const step = await this.next(w);
        if (step && (await this.move(w, step.to, step.hashes, step.evidence))) moved++;
      } catch (err) {
        this.log.warn({ withdrawal: w.id, err: (err as Error).message }, 'withdrawal tracking step failed');
      }
    }
    return moved;
  }

  private async next(w: WithdrawalRow): Promise<{ to: states.WithdrawalState; hashes?: WithdrawalRow['tx_hashes']; evidence?: Record<string, unknown> } | null> {
    if (w.status === 'PREPARED' || w.status === 'SUBMITTED') {
      if (w.op_status === 'SETTLED') return { to: 'SENT', hashes: { ...w.tx_hashes, near: w.relay_tx_hashes.at(-1) } };
      if (['FAILED', 'EXPIRED', 'REJECTED'].includes(w.op_status)) return { to: 'FAILED', evidence: { reason: `op_${w.op_status.toLowerCase()}` } };
      if (w.status === 'PREPARED' && ['PREPARED', 'COSIGNED'].includes(w.op_status) && w.op_expired) return { to: 'FAILED', evidence: { reason: 'not_signed' } };
      if (w.status === 'PREPARED' && ['SUBMITTED', 'RELAYED', 'UNKNOWN'].includes(w.op_status)) return { to: 'SUBMITTED' };
      return null;
    }
    if (w.status === 'SENT' || w.status === 'PROCESSING') {
      const st = await this.oneclick.status(w.deposit_address);
      const to = withdrawalState(st.status);
      const h = swapHashes(st);
      const hashes = { ...w.tx_hashes, destination: h.near.length ? h.near : w.tx_hashes.destination, origin: h.origin };
      if (!to || to === w.status) return null;
      return { to, hashes, evidence: to === 'REVIEW_REQUIRED' ? { reason: `oneclick_${st.status.toLowerCase()}` } : undefined };
    }
    if (w.status === 'VERIFYING') {
      const dest = this.destinations.get(w.destination);
      const rpc = dest ? this.evm.get(dest.network) : undefined;
      const hashes = w.tx_hashes.destination ?? [];
      if (!dest || !rpc || hashes.length === 0) return w.stale ? { to: 'REVIEW_REQUIRED', evidence: { reason: !rpc ? 'no_destination_rpc' : 'no_destination_tx' } } : null;
      for (const txHash of hashes) {
        const r = await verifyEvmTransfer(rpc, { txHash, token: dest.tokenAddress, recipient: w.recipient, minAmount: BigInt(w.min_amount_out), confirmations: dest.confirmations });
        if (r.ok) return { to: 'COMPLETED', evidence: { tx_hash: txHash, amount: r.amount.toString(), block: r.blockNumber.toString() } };
        if (r.final) return { to: 'REVIEW_REQUIRED', evidence: { reason: r.reason, tx_hash: txHash } };
      }
      return w.stale ? { to: 'REVIEW_REQUIRED', evidence: { reason: 'verification_timeout' } } : null;
    }
    return null;
  }

  private async move(w: WithdrawalRow, to: states.WithdrawalState, hashes?: WithdrawalRow['tx_hashes'], evidence?: Record<string, unknown>): Promise<boolean> {
    if (!states.withdrawal.can(w.status, to)) {
      this.log.warn({ withdrawal: w.id, from: w.status, to }, 'ignoring impossible withdrawal transition');
      return false;
    }
    const moved = await withTx(this.pool, async (c) => {
      const r = await c.query(
        'update ops.withdrawals set status = $3, tx_hashes = coalesce($4::jsonb, tx_hashes), evidence = coalesce($5::jsonb, evidence), updated_at = now() where id = $1 and status = $2',
        [w.id, w.status, to, hashes ? JSON.stringify(hashes) : null, evidence ? JSON.stringify(evidence) : null],
      );
      if (r.rowCount && (to === 'REVIEW_REQUIRED' || to === 'FAILED')) {
        await c.query("insert into audit.log(actor, action, target, outcome, details) values ('worker', 'withdrawal.track', $1, 'FAILED', $2)", [
          w.id,
          JSON.stringify({ to, ...(evidence ?? {}) }),
        ]);
      }
      if (r.rowCount) {
        const email = withdrawalEmail(w, to, this.destinations.get(w.destination)?.label ?? w.destination, evidence);
        if (email) await enqueueEmail(c, email);
      }
      return (r.rowCount ?? 0) > 0;
    });
    if (moved) await publishUserEvents(this.publisher, [{ uid: w.uid, kind: 'withdrawal', id: w.id, status: to }]);
    return moved;
  }
}

interface InvoicePaymentRow {
  id: string;
  invoice_id: string;
  merchant_uid: string;
  invoice_status: string;
  deposit_address: string;
  deposit_memo: string | null;
  status: states.InvoiceDepositState;
  deadline: string | null;
  stale: boolean;
  tx_hashes: unknown;
}

export class InvoicePaymentTracker {
  constructor(
    private readonly pool: Pool,
    private readonly oneclick: Pick<OneClickClient, 'status'>,
    private readonly intentsSender: string,
    private readonly log: Logger,
    private readonly publisher: EventPublisher,
  ) {}

  async trackBatch(limit = 25): Promise<number> {
    const rows = (
      await this.pool.query<InvoicePaymentRow>(
        `select d.id, d.invoice_id, i.merchant_uid, i.status as invoice_status, d.deposit_address, d.deposit_memo, d.status,
                d.quote->'quote'->>'deadline' as deadline, d.tx_hashes,
                d.updated_at < now() - make_interval(mins => $2) as stale
           from ops.invoice_deposits d join ops.invoices i on i.invoice_id = d.invoice_id
          where d.status = any($1) order by d.updated_at limit $3`,
        [ACTIVE_INVOICE_PAYMENTS, DELIVERY_TIMEOUT_MINUTES, limit],
      )
    ).rows;
    let moved = 0;
    for (const d of rows) {
      try {
        if (d.invoice_status === 'PAID') {
          moved += await this.move(d, 'COMPLETED');
          continue;
        }
        if (d.status === 'DELIVERED') {
          if (d.stale) moved += await this.move(d, 'REVIEW_REQUIRED');
          continue;
        }
        const st = await this.oneclick.status(d.deposit_address, d.deposit_memo);
        const hashes = swapHashes(st);
        let to = invoiceDepositState(st.status);
        const deadline = d.deadline ? Date.parse(d.deadline) : NaN;
        if ((!to || to === 'AWAITING_DEPOSIT') && d.status === 'AWAITING_DEPOSIT' && Number.isFinite(deadline) && Date.now() > deadline + DEADLINE_GRACE_MS) to = 'EXPIRED';
        if (!to || to === d.status) continue;
        moved += await this.move(d, to, hashes);
      } catch (err) {
        this.log.warn({ payment: d.id, err: (err as Error).message }, 'invoice payment tracking step failed');
      }
    }
    return moved;
  }

  private async move(d: InvoicePaymentRow, to: states.InvoiceDepositState, hashes?: { origin: string[]; near: string[] }): Promise<number> {
    if (!states.invoiceDeposit.can(d.status, to)) {
      this.log.warn({ payment: d.id, from: d.status, to }, 'ignoring impossible invoice payment transition');
      return 0;
    }
    const moved = await withTx(this.pool, async (c) => {
      const r = await c.query('update ops.invoice_deposits set status = $3, tx_hashes = coalesce($4::jsonb, tx_hashes), updated_at = now() where id = $1 and status = $2', [
        d.id,
        d.status,
        to,
        hashes ? JSON.stringify(hashes) : null,
      ]);
      if (!r.rowCount) return false;
      if (to === 'DELIVERED') {
        for (const h of hashes?.near ?? []) {
          if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(h)) continue;
          await c.query('insert into infra.outbox(topic, payload) values ($1, $2)', [TOPICS.ingest, JSON.stringify({ tx_hash: h, sender: this.intentsSender })]);
        }
      }
      if (['REFUNDED', 'EXPIRED', 'FAILED'].includes(to)) await c.query('select ops.release_invoice($1)', [d.invoice_id]);
      if (to === 'REVIEW_REQUIRED' || to === 'FAILED') {
        await c.query("insert into audit.log(actor, action, target, outcome, details) values ('worker', 'invoice.crosschain_track', $1, 'FAILED', $2)", [
          d.id,
          JSON.stringify({ to, invoice_id: d.invoice_id }),
        ]);
      }
      return true;
    });
    if (!moved) return 0;
    await publishUserEvents(this.publisher, [{ uid: d.merchant_uid, kind: 'invoice', id: d.invoice_id, status: to === 'COMPLETED' ? 'PAID' : `PAYMENT_${to}` }]);
    return 1;
  }
}

export class SandboxSettler {
  constructor(
    private readonly pool: Pool,
    private readonly settleAfterSeconds: number,
    private readonly log: Logger,
    private readonly publisher: EventPublisher,
  ) {}

  async settleBatch(limit = 50): Promise<number> {
    const due = (
      await this.pool.query<{ id: string }>(
        "select id from ops.sandbox_ops where status = 'PENDING' and funding = 'DEMO' and created_at <= now() - make_interval(secs => $1) order by created_at limit $2",
        [this.settleAfterSeconds, limit],
      )
    ).rows;
    let settled = 0;
    for (const { id } of due) {
      try {
        const r = await withTx(this.pool, (c) => settleSandboxOp(c, id, this.settleAfterSeconds, () => Array.from({ length: 20 }, () => randomInt(10)).join('')));
        if (!r) continue;
        settled++;
        await publishUserEvents(this.publisher, [{ uid: r.uid, kind: 'balance', id: r.id, status: `SANDBOX_${r.status}` }]);
      } catch (err) {
        this.log.warn({ sandbox: id, err: (err as Error).message }, 'sandbox settlement failed');
      }
    }
    return settled;
  }
}
