'use client';

import { Freshness, Health, LoadError, PageHeader, Panel, Section, Skeleton, Time } from '@/components/ui';
import { DataTable, type Column } from '@/components/table';
import { useResource } from '@/lib/api';
import { formatCount, shortId } from '@/lib/format';
import type { ProvidersView } from '@/lib/types';

type Asset = ProvidersView['assets'][number];

const assetCols: Column<Asset>[] = [
  { key: 'token', header: 'Token contract', cell: (a) => <span className="font-mono text-[12.5px] text-ink-2" title={a.token}>{shortId(a.token, 18, 8)}</span> },
  { key: 'cur', header: 'Accounting unit', cell: (a) => a.currency },
  { key: 'dec', header: 'Decimals', align: 'right', cell: (a) => <span className="tnum">{a.decimals}</span> },
  { key: 'net', header: 'Network', cell: (a) => a.network },
  { key: 'events', header: 'Transfers observed', align: 'right', cell: (a) => <span className="tnum">{formatCount(a.events)}</span>, sort: (a) => a.events },
  { key: 'last', header: 'Last observed', cell: (a) => <Time iso={a.lastObserved} relative className="text-ink-3" /> },
];

export default function ProvidersPage() {
  const res = useResource<ProvidersView>('/v1/ops/providers');
  const p = res.data;
  return (
    <>
      <PageHeader title="Providers & networks" description="Every external dependency, who owns it, and the evidence its outcomes need before Obiba treats them as settled." actions={<Freshness observedAt={p?.observedAt} refreshing={res.refreshing} onRefresh={res.refresh} />} />
      {res.error && !p && <LoadError error={res.error} onRetry={res.refresh} />}
      {!p ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <>
          <Section title="Registry">
            <Panel className="divide-y divide-hairline">
              {p.providers.map((x) => (
                <div key={x.key} className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(0,280px)_120px_minmax(0,1fr)]">
                  <div>
                    <div className="text-sm font-semibold text-ink">{x.name}</div>
                    <div className="text-sm text-muted">{x.role}</div>
                    <div className="mt-1 text-xs text-subtle">Owner: {x.owner}</div>
                  </div>
                  <div>
                    <Health state={x.state} />
                    <div className="text-xs text-muted">{x.observedAt ? <Time iso={x.observedAt} relative /> : 'Not observed'}</div>
                  </div>
                  <div className="min-w-0">
                    <dl className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
                      {x.metrics.map((m) => (
                        <div key={m.label} className="flex justify-between gap-3 text-sm">
                          <dt className="text-muted">{m.label}</dt>
                          <dd className="tnum truncate text-right text-ink-2" title={m.value}>{m.value}</dd>
                        </div>
                      ))}
                    </dl>
                    {x.stateNote && <p className="mt-2 text-xs text-caution">{x.stateNote}</p>}
                    <p className="mt-2 text-xs text-muted">{x.settlementPolicy}</p>
                  </div>
                </div>
              ))}
            </Panel>
          </Section>
          <Section title="Assets" description="Token contracts the indexer attributes to USDC. Adding an issuer or chain needs its own accounting and reconciliation treatment.">
            <DataTable caption="Assets" columns={assetCols} rows={p.assets} rowKey={(a) => a.token} minWidth={720} />
          </Section>
          <p className="text-xs text-muted">Endpoints, routing and supported assets change only through reviewed configuration and deployment, never from this console.</p>
        </>
      )}
    </>
  );
}
