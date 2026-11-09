'use client';

import Link from 'next/link';
import type { Column } from '@/components/table';
import { Amount, Copyable, Status, Time } from '@/components/ui';
import { shortId } from '@/lib/format';
import { counterpartyLabel, PHASE, statusLabel, TX_TYPE_LABEL } from '@/lib/labels';
import type { TxRow } from '@/lib/types';

export const txColumns: Column<TxRow>[] = [
  { key: 'created', header: 'Created', width: '130px', cell: (r) => <Time iso={r.createdAt} short className="text-ink-3" />, sort: (r) => r.createdAt },
  {
    key: 'customer',
    header: 'Customer',
    cell: (r) =>
      r.uid ? (
        <div className="min-w-0">
          <Link href={`/customers/${r.uid}`} className="font-medium text-ink hover:underline">
            {r.customer ?? 'Unnamed'}
          </Link>
          <div className="max-w-[200px] truncate text-xs text-muted">{r.handle ? `@${r.handle}` : (r.accountId ?? 'No account')}</div>
        </div>
      ) : (
        <span className="text-subtle">Unattributed</span>
      ),
    sort: (r) => r.customer ?? '',
  },
  { key: 'type', header: 'Type', cell: (r) => <span className="whitespace-nowrap">{TX_TYPE_LABEL[r.type]}</span>, sort: (r) => r.type },
  { key: 'counterparty', header: 'Counterparty', cell: (r) => <span className="block max-w-[200px] truncate text-ink-3" title={r.counterparty}>{counterpartyLabel(r.type, r.counterparty)}</span>, hideable: true, label: 'Counterparty' },
  { key: 'amount', header: 'Amount', align: 'right', cell: (r) => <Amount value={r.amount} currency={r.currency} />, sort: (r) => BigInt(r.amount), className: 'whitespace-nowrap' },
  {
    key: 'status',
    header: 'Status',
    cell: (r) => (
      <div title={PHASE[r.phase].explain}>
        <Status tone={PHASE[r.phase].tone}>{PHASE[r.phase].label}</Status>
        <div className="text-xs text-muted">{statusLabel(r.status)}</div>
      </div>
    ),
    sort: (r) => r.phase,
  },
  { key: 'rail', header: 'Rail', cell: (r) => <span className="whitespace-nowrap text-ink-3">{r.rail}</span>, hideable: true, defaultHidden: true, label: 'Rail' },
  { key: 'reference', header: 'Reference', cell: (r) => (r.reference ? <Copyable value={r.reference} display={shortId(r.reference, 10, 6)} /> : <span className="text-subtle">—</span>), hideable: true, label: 'Reference' },
  { key: 'id', header: 'Operation ID', cell: (r) => <Copyable value={r.id} display={shortId(r.id)} />, hideable: true, defaultHidden: true, label: 'Operation ID' },
  { key: 'updated', header: 'Last change', cell: (r) => <Time iso={r.updatedAt} relative className="text-muted" />, hideable: true, defaultHidden: true, label: 'Last change', sort: (r) => r.updatedAt },
];
