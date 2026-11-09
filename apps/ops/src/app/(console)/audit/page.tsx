'use client';

import { useEffect, useMemo, useState } from 'react';
import { ClearFilters, SearchField } from '@/components/filters';
import { Drawer } from '@/components/overlay';
import { Gated } from '@/components/shell';
import { DataTable, Pager, useCursorPages, type Column } from '@/components/table';
import { Copyable, Freshness, KeyValues, PageHeader, Select, Status, Time } from '@/components/ui';
import { qs, useResource } from '@/lib/api';
import { RANGES, rangeFrom, useFilters } from '@/lib/filters';
import { shortId } from '@/lib/format';
import type { AuditRow, Page } from '@/lib/types';

const KEYS = ['q', 'actor', 'action', 'outcome', 'kind', 'range'] as const;
const OUTCOME: Record<string, ['positive' | 'critical' | 'neutral', string]> = { ALLOWED: ['neutral', 'Allowed'], DENIED: ['critical', 'Denied'], FAILED: ['critical', 'Failed'] };
const KIND: Record<string, string> = { staff: 'Staff', customer: 'Customer', service: 'Service' };

const columns: Column<AuditRow>[] = [
  { key: 'at', header: 'Time', width: '170px', cell: (r) => <Time iso={r.at} className="text-ink-3" /> },
  { key: 'actor', header: 'Actor', cell: (r) => <div><div className="max-w-[240px] truncate text-ink-2" title={r.actor}>{r.actor.replace(/^staff:/, '')}</div><div className="text-xs text-muted">{KIND[r.actorKind]}</div></div> },
  { key: 'action', header: 'Action', cell: (r) => <span className="font-mono text-[12.5px] text-ink">{r.action}</span> },
  { key: 'target', header: 'Resource', cell: (r) => (r.target ? <Copyable value={r.target} display={shortId(r.target, 14, 6)} /> : <span className="text-subtle">—</span>) },
  { key: 'outcome', header: 'Outcome', cell: (r) => <Status tone={OUTCOME[r.outcome]![0]} strong={r.outcome !== 'ALLOWED'}>{OUTCOME[r.outcome]![1]}</Status> },
  { key: 'details', header: 'Details', cell: (r) => <span className="block max-w-[280px] truncate font-mono text-[12px] text-muted">{Object.keys(r.details).length ? JSON.stringify(r.details) : '—'}</span>, hideable: true, label: 'Details' },
];

export default function AuditPage() {
  return (
    <>
      <PageHeader title="Audit trail" description="Append-only record of sensitive views, exports, access changes, requests, approvals and outcomes." />
      <Gated capability="audit.read">
        <AuditBody />
      </Gated>
    </>
  );
}

function AuditBody() {
  const [f, set, reset] = useFilters(KEYS, 'audit');
  const pages = useCursorPages();
  const [open, setOpen] = useState<AuditRow | null>(null);
  const from = useMemo(() => rangeFrom(f.range), [f.range]);
  const res = useResource<Page<AuditRow> & { actions: string[]; integrity: string }>(`/v1/ops/audit${qs({ q: f.q, actor: f.actor, action: f.action, outcome: f.outcome, kind: f.kind, from, cursor: pages.cursor, limit: 50 })}`);
  const { reset: resetPages } = pages;
  useEffect(() => resetPages(), [f.q, f.actor, f.action, f.outcome, f.kind, f.range, resetPages]);
  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-4 text-sm text-muted">
        <span>{res.data?.integrity}</span>
        <Freshness observedAt={res.data?.observedAt} refreshing={res.refreshing} onRefresh={res.refresh} />
      </div>
      <DataTable
        caption="Audit trail"
        storageKey="audit"
        columns={columns}
        rows={res.data?.rows ?? null}
        rowKey={(r) => r.id}
        onRowClick={setOpen}
        selectedKey={open?.id}
        loading={res.loading}
        error={res.error}
        onRetry={res.refresh}
        stale={res.refreshing}
        toolbar={
          <>
            <SearchField value={f.q} onCommit={(q) => set({ q })} placeholder="Exact resource, request ID or entry number" className="max-w-[300px]" />
            <SearchField value={f.actor} onCommit={(actor) => set({ actor })} placeholder="Actor" label="Actor" className="max-w-[200px] min-w-[160px]" />
            <Select label="Action" value={f.action} onChange={(action) => set({ action })} options={[{ value: '', label: 'All actions' }, ...(res.data?.actions ?? (f.action ? [f.action] : [])).map((a) => ({ value: a, label: a }))]} />
            <Select label="Actor type" value={f.kind} onChange={(kind) => set({ kind })} options={[{ value: '', label: 'All actors' }, { value: 'staff', label: 'Staff' }, { value: 'customer', label: 'Customers' }, { value: 'service', label: 'Services' }]} />
            <Select label="Outcome" value={f.outcome} onChange={(outcome) => set({ outcome })} options={[{ value: '', label: 'All outcomes' }, { value: 'ALLOWED', label: 'Allowed' }, { value: 'DENIED', label: 'Denied' }, { value: 'FAILED', label: 'Failed' }]} />
            <Select label="Time" value={f.range} onChange={(range) => set({ range })} options={RANGES} />
            <ClearFilters active={KEYS.some((k) => f[k])} onClear={reset} />
          </>
        }
        footer={res.data && <Pager page={pages.page} count={res.data.rows.length} noun="entries on this page" hasPrev={pages.page > 1} hasNext={!!res.data.nextCursor} onPrev={pages.prev} onNext={() => res.data?.nextCursor && pages.next(res.data.nextCursor)} />}
      />
      {open && (
        <Drawer open onClose={() => setOpen(null)} title={<span className="font-mono">{open.action}</span>} subtitle={<>Entry {open.id} · <Time iso={open.at} /></>}>
          <KeyValues
            rows={[
              { label: 'Actor', value: <span className="break-all">{open.actor}</span>, hint: KIND[open.actorKind] },
              { label: 'Outcome', value: <Status tone={OUTCOME[open.outcome]![0]}>{OUTCOME[open.outcome]![1]}</Status> },
              { label: 'Resource', value: open.target ? <Copyable value={open.target} /> : null },
              { label: 'Request ID', value: open.requestId ? <Copyable value={open.requestId} /> : null },
              { label: 'Recorded at (UTC)', value: <span className="tnum">{open.at}</span> },
            ]}
          />
          <h3 className="mt-6 mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">Recorded details</h3>
          {Object.keys(open.details).length === 0 ? (
            <p className="text-sm text-muted">No additional details were recorded.</p>
          ) : (
            <KeyValues rows={Object.entries(open.details).map(([k, v]) => ({ label: <span className="font-mono text-[12px]">{k}</span>, value: <span className="font-mono text-[12.5px] break-all">{typeof v === 'string' ? v : JSON.stringify(v)}</span> }))} />
          )}
        </Drawer>
      )}
    </>
  );
}
