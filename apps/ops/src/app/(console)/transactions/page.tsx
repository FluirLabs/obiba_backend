'use client';

import { useEffect, useMemo } from 'react';
import { ClearFilters, SearchField } from '@/components/filters';
import { DataTable, Pager, useCursorPages } from '@/components/table';
import { Freshness, PageHeader, Select } from '@/components/ui';
import { qs, useResource } from '@/lib/api';
import { RANGES, rangeFrom, useFilters } from '@/lib/filters';
import { shortId } from '@/lib/format';
import { PHASE, PHASES, TX_TYPE_LABEL, TX_TYPES } from '@/lib/labels';
import { txColumns as columns } from '@/features/tx-columns';
import type { Page, TxRow } from '@/lib/types';

const KEYS = ['q', 'type', 'phase', 'currency', 'range', 'uid'] as const;


export default function TransactionsPage() {
  const [f, set, reset] = useFilters(KEYS, 'transactions');
  const pages = useCursorPages();
  const from = useMemo(() => rangeFrom(f.range), [f.range]);
  const path = `/v1/ops/transactions${qs({ q: f.q, type: f.type, phase: f.phase, currency: f.currency, from, uid: f.uid, cursor: pages.cursor, limit: 50 })}`;
  const res = useResource<Page<TxRow>>(path);
  const { reset: resetPages } = pages;
  useEffect(() => resetPages(), [f.q, f.type, f.phase, f.currency, f.range, f.uid, resetPages]);
  const active = KEYS.some((k) => f[k]);

  return (
    <>
      <PageHeader
        title="Transactions"
        description="Every operation across NEAR, NEAR Intents and the local services pilot rail. Provider, chain and ledger states are tracked separately on each record."
        actions={<Freshness observedAt={res.data?.observedAt} refreshing={res.refreshing} onRefresh={res.refresh} />}
      />
      <DataTable
        caption="Transactions"
        storageKey="transactions"
        columns={columns}
        rows={res.data?.rows ?? null}
        rowKey={(r) => `${r.type}:${r.id}`}
        rowHref={(r) => `/transactions/${r.type}/${encodeURIComponent(r.id)}`}
        loading={res.loading}
        error={res.error}
        onRetry={res.refresh}
        stale={res.refreshing}
        toolbar={
          <>
            <SearchField value={f.q} onCommit={(q) => set({ q })} placeholder="Operation ID, customer, @handle, account, address, provider reference or hash" className="max-w-[440px]" />
            <Select label="Type" value={f.type} onChange={(type) => set({ type })} options={[{ value: '', label: 'All types' }, ...TX_TYPES.map((t) => ({ value: t, label: TX_TYPE_LABEL[t] }))]} />
            <Select label="Outcome" value={f.phase} onChange={(phase) => set({ phase })} options={[{ value: '', label: 'All outcomes' }, ...PHASES.map((p) => ({ value: p, label: PHASE[p].label }))]} />
            <Select label="Asset" value={f.currency} onChange={(currency) => set({ currency })} options={[{ value: '', label: 'All assets' }, { value: 'USDC', label: 'USDC' }, { value: 'DEMO_USDC', label: 'Pilot USDC' }]} />
            <Select label="Created" value={f.range} onChange={(range) => set({ range })} options={RANGES} />
            {f.uid && (
              <span className="inline-flex h-8 items-center gap-1 rounded-md border border-line bg-raised px-2.5 text-sm text-ink-3">
                Customer {shortId(f.uid, 6, 4)}
              </span>
            )}
            <ClearFilters active={active} onClear={reset} />
          </>
        }
        footer={
          res.data && (
            <Pager
              page={pages.page}
              count={res.data.rows.length}
              noun="transactions on this page"
              hasPrev={pages.page > 1}
              hasNext={!!res.data.nextCursor}
              onPrev={pages.prev}
              onNext={() => res.data?.nextCursor && pages.next(res.data.nextCursor)}
            />
          )
        }
      />
      <p className="mt-2 text-xs text-muted">Newest first. Column sorting reorders the rows on this page only. Contact search by email or phone requires the operator role and is enforced by the server.</p>
    </>
  );
}
