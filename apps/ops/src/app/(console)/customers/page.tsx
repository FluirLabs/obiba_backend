'use client';

import { useEffect } from 'react';
import { ClearFilters, SearchField } from '@/components/filters';
import { DataTable, Pager, useCursorPages, type Column } from '@/components/table';
import { Amount, Freshness, PageHeader, Select, Status, Time } from '@/components/ui';
import { qs, useResource } from '@/lib/api';
import { useFilters } from '@/lib/filters';
import { statusLabel } from '@/lib/labels';
import type { CustomerRow, Page } from '@/lib/types';

const KEYS = ['q', 'status'] as const;

function accountTone(s: string | null) {
  return s === 'active' ? 'neutral' : s === 'frozen' || s === 'quarantined' ? 'critical' : 'caution';
}

const columns: Column<CustomerRow>[] = [
  {
    key: 'customer',
    header: 'Customer',
    cell: (r) => (
      <div className="min-w-0">
        <div className="font-medium text-ink">{r.name}</div>
        <div className="text-xs text-muted">{r.handle ? `@${r.handle}` : 'No handle'}</div>
      </div>
    ),
    sort: (r) => r.name.toLowerCase(),
  },
  { key: 'account', header: 'NEAR account', cell: (r) => (r.accountId ? <span className="block max-w-[260px] truncate font-mono text-[12.5px] text-ink-2" title={r.accountId}>{r.accountId}</span> : <span className="text-subtle">Not provisioned</span>) },
  {
    key: 'state',
    header: 'State',
    cell: (r) => (
      <div>
        <Status tone={r.status === 'disabled' ? 'critical' : accountTone(r.accountStatus)}>{r.status === 'disabled' ? 'Profile disabled' : r.accountStatus ? `Account ${statusLabel(r.accountStatus).toLowerCase()}` : 'No account'}</Status>
        {!r.pilot && <div className="text-xs text-caution">Awaiting pilot access</div>}
      </div>
    ),
    sort: (r) => `${r.status}${r.accountStatus}`,
  },
  { key: 'balance', header: 'USDC posted', align: 'right', cell: (r) => (r.balance === null ? <span className="text-subtle">No ledger account</span> : <Amount value={r.balance} currency={r.currency} />), sort: (r) => BigInt(r.balance ?? '0') },
  { key: 'held', header: 'Reserved', align: 'right', cell: (r) => (r.held && r.held !== '0' ? <Amount value={r.held} currency={r.currency} /> : <span className="text-subtle">—</span>), hideable: true, label: 'Reserved' },
  { key: 'phone', header: 'Phone', cell: (r) => <div><span className="tnum text-ink-3">{r.phone}</span><div className="text-xs text-muted">{r.phoneVerified ? 'SMS verified' : 'Not SMS verified'}</div></div>, hideable: true, label: 'Phone' },
  { key: 'email', header: 'Email', cell: (r) => <span className="text-ink-3">{r.email}</span>, hideable: true, defaultHidden: true, label: 'Email' },
  { key: 'cases', header: 'Open cases', align: 'right', cell: (r) => (r.openCases ? <Status tone="caution">{r.openCases}</Status> : <span className="text-subtle">0</span>), sort: (r) => r.openCases, hideable: true, label: 'Open cases' },
  { key: 'activity', header: 'Last activity', cell: (r) => <Time iso={r.lastActivity} relative className="text-muted" />, sort: (r) => r.lastActivity ?? '', hideable: true, label: 'Last activity' },
  { key: 'joined', header: 'Joined', cell: (r) => <Time iso={r.createdAt} short className="text-muted" />, sort: (r) => r.createdAt, hideable: true, label: 'Joined' },
];

export default function CustomersPage() {
  const [f, set, reset] = useFilters(KEYS, 'customers');
  const pages = useCursorPages();
  const res = useResource<Page<CustomerRow>>(`/v1/ops/customers${qs({ q: f.q, status: f.status, cursor: pages.cursor, limit: 50 })}`);
  const { reset: resetPages } = pages;
  useEffect(() => resetPages(), [f.q, f.status, resetPages]);

  return (
    <>
      <PageHeader title="Customers" description="Contact details are masked by default. Revealing them requires a stated reason and is recorded in the audit trail." actions={<Freshness observedAt={res.data?.observedAt} refreshing={res.refreshing} onRefresh={res.refresh} />} />
      <DataTable
        caption="Customers"
        storageKey="customers"
        columns={columns}
        rows={res.data?.rows ?? null}
        rowKey={(r) => r.uid}
        rowHref={(r) => `/customers/${r.uid}`}
        loading={res.loading}
        error={res.error}
        onRetry={res.refresh}
        stale={res.refreshing}
        toolbar={
          <>
            <SearchField value={f.q} onCommit={(q) => set({ q })} placeholder="Name, @handle, account, customer ID, exact email or phone" className="max-w-[420px]" />
            <Select
              label="State"
              value={f.status}
              onChange={(status) => set({ status })}
              options={[
                { value: '', label: 'All states' },
                { value: 'active', label: 'Profile active' },
                { value: 'disabled', label: 'Profile disabled' },
                { value: 'frozen', label: 'Account frozen' },
                { value: 'quarantined', label: 'Account quarantined' },
                { value: 'provisioning', label: 'Provisioning' },
              ]}
            />
            <ClearFilters active={!!(f.q || f.status)} onClear={reset} />
          </>
        }
        footer={res.data && <Pager page={pages.page} count={res.data.rows.length} noun="customers on this page" hasPrev={pages.page > 1} hasNext={!!res.data.nextCursor} onPrev={pages.prev} onNext={() => res.data?.nextCursor && pages.next(res.data.nextCursor)} />}
      />
    </>
  );
}
