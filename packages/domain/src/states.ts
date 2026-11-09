export class TransitionError extends Error {}

function machine<S extends string>(edges: Record<S, readonly S[]>) {
  return {
    can(from: S, to: S): boolean {
      return edges[from]?.includes(to) ?? false;
    },
    assert(from: S, to: S): void {
      if (!edges[from]?.includes(to)) throw new TransitionError(`illegal transition ${from} -> ${to}`);
    },
    terminal(state: S): boolean {
      return (edges[state] ?? []).length === 0;
    },
  };
}

export type DepositState =
  | 'CREATED'
  | 'AWAITING_DEPOSIT'
  | 'DETECTED'
  | 'CONVERTING'
  | 'VERIFYING_SETTLEMENT'
  | 'CREDITED'
  | 'INCOMPLETE'
  | 'EXPIRED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'FAILED'
  | 'REVIEW_REQUIRED';

export const deposit = machine<DepositState>({
  CREATED: ['AWAITING_DEPOSIT', 'FAILED'],
  AWAITING_DEPOSIT: ['DETECTED', 'CONVERTING', 'VERIFYING_SETTLEMENT', 'EXPIRED', 'INCOMPLETE', 'REFUND_PENDING', 'REFUNDED', 'FAILED', 'REVIEW_REQUIRED'],
  DETECTED: ['CONVERTING', 'VERIFYING_SETTLEMENT', 'INCOMPLETE', 'REFUND_PENDING', 'REFUNDED', 'FAILED', 'REVIEW_REQUIRED'],
  CONVERTING: ['VERIFYING_SETTLEMENT', 'INCOMPLETE', 'REFUND_PENDING', 'REFUNDED', 'FAILED', 'REVIEW_REQUIRED'],
  VERIFYING_SETTLEMENT: ['CREDITED', 'REVIEW_REQUIRED'],
  INCOMPLETE: ['REFUND_PENDING', 'REFUNDED', 'REVIEW_REQUIRED'],
  EXPIRED: ['DETECTED', 'CONVERTING', 'VERIFYING_SETTLEMENT', 'REVIEW_REQUIRED'],
  REFUND_PENDING: ['REFUNDED', 'REVIEW_REQUIRED'],
  FAILED: ['REVIEW_REQUIRED'],
  REVIEW_REQUIRED: ['CREDITED', 'REFUNDED', 'FAILED'],
  CREDITED: [],
  REFUNDED: [],
});

export type OpState = 'PREPARED' | 'COSIGNED' | 'SUBMITTED' | 'RELAYED' | 'SETTLED' | 'EXPIRED' | 'REJECTED' | 'FAILED' | 'UNKNOWN';

export const preparedOp = machine<OpState>({
  PREPARED: ['COSIGNED', 'SUBMITTED', 'EXPIRED', 'REJECTED'],
  COSIGNED: ['SUBMITTED', 'EXPIRED'],
  SUBMITTED: ['RELAYED', 'FAILED', 'UNKNOWN'],
  RELAYED: ['SETTLED', 'FAILED', 'UNKNOWN'],
  UNKNOWN: ['SETTLED', 'FAILED'],
  SETTLED: [],
  EXPIRED: [],
  REJECTED: [],
  FAILED: [],
});

export type InvoiceState = 'OPEN' | 'PAYING' | 'PAID' | 'EXPIRED' | 'CANCELLED';

export const invoice = machine<InvoiceState>({
  OPEN: ['PAYING', 'PAID', 'EXPIRED', 'CANCELLED'],
  PAYING: ['OPEN', 'PAID'],
  PAID: [],
  EXPIRED: ['PAID'],
  CANCELLED: [],
});

export type SandboxState = 'CREATED' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REVIEW';

export const sandboxOp = machine<SandboxState>({
  CREATED: ['PENDING'],
  PENDING: ['SUCCEEDED', 'FAILED', 'REVIEW'],
  REVIEW: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [],
});

export type WithdrawalState = 'PREPARED' | 'SUBMITTED' | 'SENT' | 'PROCESSING' | 'VERIFYING' | 'COMPLETED' | 'REFUNDED' | 'FAILED' | 'REVIEW_REQUIRED';

export const withdrawal = machine<WithdrawalState>({
  PREPARED: ['SUBMITTED', 'SENT', 'FAILED'],
  SUBMITTED: ['SENT', 'FAILED'],
  SENT: ['PROCESSING', 'VERIFYING', 'REFUNDED', 'REVIEW_REQUIRED'],
  PROCESSING: ['VERIFYING', 'REFUNDED', 'REVIEW_REQUIRED'],
  VERIFYING: ['COMPLETED', 'REVIEW_REQUIRED'],
  REVIEW_REQUIRED: ['COMPLETED', 'REFUNDED'],
  COMPLETED: [],
  REFUNDED: [],
  FAILED: [],
});

export type InvoiceDepositState =
  | 'AWAITING_DEPOSIT'
  | 'DETECTED'
  | 'CONVERTING'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'INCOMPLETE'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'EXPIRED'
  | 'FAILED'
  | 'REVIEW_REQUIRED';

export const invoiceDeposit = machine<InvoiceDepositState>({
  AWAITING_DEPOSIT: ['DETECTED', 'CONVERTING', 'DELIVERED', 'INCOMPLETE', 'REFUND_PENDING', 'REFUNDED', 'EXPIRED', 'FAILED', 'REVIEW_REQUIRED', 'COMPLETED'],
  DETECTED: ['CONVERTING', 'DELIVERED', 'INCOMPLETE', 'REFUND_PENDING', 'REFUNDED', 'FAILED', 'REVIEW_REQUIRED', 'COMPLETED'],
  CONVERTING: ['DELIVERED', 'INCOMPLETE', 'REFUND_PENDING', 'REFUNDED', 'FAILED', 'REVIEW_REQUIRED', 'COMPLETED'],
  DELIVERED: ['COMPLETED', 'REVIEW_REQUIRED'],
  INCOMPLETE: ['REFUND_PENDING', 'REFUNDED', 'REVIEW_REQUIRED'],
  REFUND_PENDING: ['REFUNDED', 'REVIEW_REQUIRED'],
  EXPIRED: ['DETECTED', 'CONVERTING', 'DELIVERED', 'REVIEW_REQUIRED', 'COMPLETED'],
  FAILED: ['REVIEW_REQUIRED'],
  REVIEW_REQUIRED: ['COMPLETED', 'REFUNDED'],
  COMPLETED: [],
  REFUNDED: [],
});
