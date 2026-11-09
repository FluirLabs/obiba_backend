'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FlowChart, FLOW_COLORS, Legend } from '@/components/chart';
import { IconArrowRight } from '@/components/icons';
import { useSession } from '@/components/shell';
import { Amount, Banner, cx, Empty, Freshness, Health, LoadError, Metric, PageHeader, Panel, Section, Select, Skeleton, Status, Time } from '@/components/ui';
import { qs, useResource } from '@/lib/api';
import { formatAmount, formatCount, formatPercent } from '@/lib/format';
import { PHASE, SEVERITY, TX_TYPE_LABEL } from '@/lib/labels';
import { age, ago, bucketLabel, dateTime, utc } from '@/lib/time';
import type { AuditRow, Overview, Page, TxRow } from '@/lib/types';

const WINDOWS = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

export default function OverviewPage() {
  const { can, session } = useSession();
  const router = useRouter();
  const [win, setWin] = useState('24h');
  const res = useResource<Overview>(`/v1/ops/overview${qs({ window: win })}`);
  const recent = useResource<Page<TxRow>>('/v1/ops/transactions?limit=8');
  const staffActions = useResource<Page<AuditRow>>(can('audit.read') ? '/v1/ops/audit?kind=staff&limit=6' : null);
  const o = res.data;
  const windowLabel = WINDOWS.find((w) => w.value === win)!.label;
  const urgent = o?.attention.filter((a) => a.severity === 'CRITICAL' || a.severity === 'HIGH') ?? [];
  const usdc = o?.performance.volume.find((v) => v.currency === 'USDC');
  const c = o?.performance.counts;
  const total = c ? Object.values(c).reduce((s, n) => s + n, 0) : 0;
  const rangeParam = win === '24h' ? '24h' : win;

  return (
    <>
      <PageHeader
        title="Overview"
        description={`Condition of ${session.entity}. Every figure states its source and observation time; missing data shows as unknown, never as zero.`}
        actions={
          <>
            <Select label="Time window" value={win} onChange={setWin} options={WINDOWS} />
            <Freshness observedAt={o?.observedAt} refreshing={res.refreshing} onRefresh={res.refresh} />
          </>
        }
      />

      {res.error && !o && <LoadError error={res.error} onRetry={res.refresh} className="mb-8" />}

      {urgent.length > 0 && (
        <Banner tone="critical" className="mb-8" title={urgent.length === 1 ? 'A condition needs action now' : `${urgent.length} conditions need action now`}>
          <ul className="mt-1 space-y-0.5">
            {urgent.map((a) => (
              <li key={a.key}>
                <Link href={a.href} className="underline-offset-2 hover:underline">
                  {a.title}
                </Link>
                <span className="opacity-80">
                  {' '}
                  · {a.detail}
                  {a.since && ` · for ${age(a.since)}`}
                </span>
              </li>
            ))}
          </ul>
        </Banner>
      )}

      <Section title="Business performance" description={`${windowLabel}. Volume is customer USDC posted to the ledger; counts cover every operation type.`}>
        <Panel className="grid grid-cols-2 divide-hairline md:grid-cols-3 xl:grid-cols-6 [&>*]:border-hairline max-md:[&>*:nth-child(odd)]:border-r md:max-xl:[&>*:not(:nth-child(3n))]:border-r xl:[&>*:not(:last-child)]:border-r max-xl:[&>*:nth-child(-n+3)]:border-b max-md:[&>*:nth-child(-n+4)]:border-b">
          {o ? (
            <>
              <Metric label="USDC received" value={<Amount value={usdc?.inflow ?? '0'} currency="USDC" size="xl" maxFraction={2} />} caption="Into customer accounts" href="/ledger?tab=journals" />
              <Metric label="USDC sent" value={<Amount value={usdc?.outflow ?? '0'} currency="USDC" size="xl" maxFraction={2} />} caption="Out of customer accounts" href="/ledger?tab=journals" />
              <Metric label="Operations" value={formatCount(total)} caption={`${formatCount(c!.completed)} completed`} href={`/transactions?range=${rangeParam}`} />
              <Metric label="Completion rate" value={formatPercent(o.performance.completionRate)} caption={<span title={o.performance.completionFormula}>Completed ÷ (completed + failed)</span>} />
              <Metric label="Pending" value={formatCount(c!.pending + c!.review + c!.unknown)} caption={`${c!.review} in review · ${c!.unknown} unknown`} href={`/transactions?phase=pending&range=${rangeParam}`} tone={c!.unknown > 0 ? 'critical' : undefined} />
              <Metric label="Failed" value={formatCount(c!.failed)} caption={`${c!.refunded} refunded`} href={`/transactions?phase=failed&range=${rangeParam}`} tone={c!.failed > 0 ? 'critical' : undefined} />
            </>
          ) : (
            Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="px-5 py-4">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-3 h-6 w-28" />
                <Skeleton className="mt-2 h-3 w-20" />
              </div>
            ))
          )}
        </Panel>
        {o && (
          <p className="mt-2 text-xs text-muted">
            Source: {o.performance.source}. Observed <span title={utc(o.observedAt)}>{dateTime(o.observedAt)}</span>. Amounts are never combined across assets.
            {Object.keys(o.performance.valueByCurrency).includes('DEMO_USDC') && <> Pilot ledger value {formatAmount(o.performance.valueByCurrency.DEMO_USDC?.completed ?? '0', 'DEMO_USDC')} Pilot USDC completed, reported separately.</>}
          </p>
        )}
      </Section>

      <Section id="health" title="Operational health" description="Each signal is evaluated from its own evidence. Unknown and stale are not healthy.">
        <Panel className="overflow-hidden">
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-left md:min-w-[760px]">
              <thead>
                <tr className="border-b border-line bg-raised text-xs text-muted">
                  <th className="h-9 px-4 font-medium sm:px-5">Signal</th>
                  <th className="h-9 px-4 font-medium">State</th>
                  <th className="h-9 px-4 font-medium">Evidence</th>
                  <th className="hidden h-9 px-4 font-medium md:table-cell">Source</th>
                  <th className="hidden h-9 px-4 text-right font-medium sm:table-cell">Observed</th>
                  <th className="hidden h-9 w-10 sm:table-cell" />
                </tr>
              </thead>
              <tbody>
                {o
                  ? o.signals.map((s) => (
                      <tr key={s.key} onClick={(e) => s.href && !(e.target as HTMLElement).closest('a') && router.push(s.href)} className={cx('group border-b border-hairline last:border-b-0', s.href && 'cursor-pointer hover:bg-hover')}>
                        <td className="px-4 py-2.5 text-sm font-medium text-ink sm:px-5">
                          {s.href ? (
                            <Link href={s.href} className="hover:underline">
                              {s.label}
                            </Link>
                          ) : (
                            s.label
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <Health state={s.state} />
                        </td>
                        <td className="px-4 py-2.5 text-sm text-ink-3">{s.summary}</td>
                        <td className="hidden px-4 py-2.5 text-xs text-muted md:table-cell">{s.source}</td>
                        <td className="hidden px-4 py-2.5 text-right text-sm text-muted sm:table-cell">{s.observedAt ? <span className="tnum" title={`${dateTime(s.observedAt)}\n${utc(s.observedAt)}`}>{ago(s.observedAt)}</span> : <span className="text-subtle">Never</span>}</td>
                        <td className="hidden pr-4 text-right text-faint group-hover:text-ink-3 sm:table-cell">{s.href && <IconArrowRight size={14} />}</td>
                      </tr>
                    ))
                  : Array.from({ length: 6 }, (_, i) => (
                      <tr key={i} className="border-b border-hairline">
                        <td colSpan={6} className="px-5 py-3">
                          <Skeleton className="h-3 w-full" />
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </Section>

      <Section title="Requires attention" description="Unresolved discrepancies, unknown outcomes, aging holds, review cases and failed jobs, most severe first.">
        <Panel>
          {!o ? (
            <div className="p-5">
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : o.attention.length === 0 ? (
            <Empty title="Nothing requires attention">No mismatches, unknown outcomes, expired holds, open reviews or failed jobs were found. This covers only conditions the console can observe; see the health signals above for anything unknown or not configured.</Empty>
          ) : (
            <ul className="divide-y divide-hairline">
              {[...o.attention]
                .sort((a, b) => SEVERITY[a.severity]!.rank - SEVERITY[b.severity]!.rank)
                .map((a) => (
                  <li key={a.key}>
                    <Link href={a.href} className="group grid grid-cols-[88px_1fr_auto] items-center gap-4 px-5 py-3.5 hover:bg-hover sm:grid-cols-[88px_1fr_96px_120px_20px]">
                      <Status tone={SEVERITY[a.severity]!.tone}>{SEVERITY[a.severity]!.label}</Status>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-ink">{a.title}</div>
                        <div className="truncate text-sm text-muted">{a.detail}</div>
                      </div>
                      <div className="tnum text-right text-sm text-ink-2">{formatCount(a.count)}</div>
                      <div className="tnum hidden text-right text-sm text-muted sm:block">{a.since ? `for ${age(a.since)}` : '—'}</div>
                      <IconArrowRight size={14} className="hidden text-faint group-hover:text-ink-3 sm:block" />
                    </Link>
                  </li>
                ))}
            </ul>
          )}
        </Panel>
      </Section>

      <Section title="Activity and trends">
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
          <FlowPanel o={o} />
          <Panel className="flex flex-col">
            <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
              <div className="text-sm font-semibold text-ink">Latest transactions</div>
              <Link href="/transactions" className="text-sm text-brand-ink hover:underline">
                View all
              </Link>
            </div>
            {recent.error && !recent.data ? (
              <div className="p-4">
                <LoadError error={recent.error} onRetry={recent.refresh} />
              </div>
            ) : !recent.data ? (
              <div className="space-y-3 p-5">
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="h-4 w-full" />
                ))}
              </div>
            ) : recent.data.rows.length === 0 ? (
              <Empty title="No transactions yet" />
            ) : (
              <ul className="divide-y divide-hairline">
                {recent.data.rows.map((t) => (
                  <li key={`${t.type}:${t.id}`}>
                    <Link href={`/transactions/${t.type}/${encodeURIComponent(t.id)}`} className="flex items-center justify-between gap-4 px-5 py-2.5 hover:bg-hover">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-ink">{t.customer ?? 'Unattributed'}</div>
                        <div className="truncate text-xs text-muted">
                          {TX_TYPE_LABEL[t.type]} · <Time iso={t.createdAt} relative />
                        </div>
                      </div>
                      <div className="text-right">
                        <Amount value={t.amount} currency={t.currency} maxFraction={2} />
                        <div>
                          <Status tone={PHASE[t.phase].tone} className="text-xs">
                            {PHASE[t.phase].label}
                          </Status>
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </Section>

      {can('audit.read') && (
        <Section title="Recent staff actions" description="Privileged changes recorded in the audit trail." actions={<Link href="/audit?kind=staff" className="text-sm text-brand-ink hover:underline">Open audit trail</Link>}>
          <Panel>
            {!staffActions.data ? (
              <div className="p-5">
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : staffActions.data.rows.length === 0 ? (
              <Empty title="No staff actions recorded" />
            ) : (
              <ul className="divide-y divide-hairline">
                {staffActions.data.rows.map((a) => (
                  <li key={a.id} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-0.5 px-5 py-2.5 text-sm sm:grid-cols-[150px_1fr_auto]">
                    <Time iso={a.at} className="col-span-2 text-xs text-muted sm:col-span-1 sm:text-sm" />
                    <div className="min-w-0 truncate">
                      <span className="font-medium text-ink">{a.actor.replace(/^staff:/, '')}</span> <span className="font-mono text-[12.5px] text-ink-3">{a.action}</span>
                      {a.target && <span className="text-muted"> · {a.target}</span>}
                    </div>
                    <Status tone={a.outcome === 'ALLOWED' ? 'neutral' : 'critical'} strong={a.outcome !== 'ALLOWED'}>
                      {a.outcome === 'ALLOWED' ? 'Allowed' : a.outcome === 'DENIED' ? 'Denied' : 'Failed'}
                    </Status>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </Section>
      )}
    </>
  );
}

function FlowPanel({ o }: { o: Overview | null }) {
  const [table, setTable] = useState(false);
  return (
    <Panel className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-3">
        <div>
          <div className="text-sm font-semibold text-ink">Customer USDC flow</div>
          <div className="text-xs text-muted">Per {o?.bucket ?? 'hour'}, from posted journals. Received above the line, sent below.</div>
        </div>
        <div className="flex items-center gap-4">
          <Legend items={[{ label: 'Received', color: FLOW_COLORS.in }, { label: 'Sent', color: FLOW_COLORS.out }]} />
          <button type="button" onClick={() => setTable((t) => !t)} className="text-sm text-brand-ink hover:underline" aria-pressed={table}>
            {table ? 'View chart' : 'View table'}
          </button>
        </div>
      </div>
      <div className={cx('px-3 pt-4 pb-2', !o && 'h-[244px]')}>
        {!o ? (
          <Skeleton className="mx-2 h-[210px]" />
        ) : table ? (
          <div className="max-h-[220px] overflow-y-auto px-2 scrollbar-thin">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted">
                  <th className="pb-2 text-left font-medium">Period</th>
                  <th className="pb-2 text-right font-medium">Received</th>
                  <th className="pb-2 text-right font-medium">Sent</th>
                  <th className="pb-2 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {o.performance.series.map((p) => (
                  <tr key={p.at} className="border-t border-hairline">
                    <td className="py-1.5 text-ink-3">{o.bucket === 'hour' ? `${bucketLabel(p.at, 'day')} ${bucketLabel(p.at, 'hour')}` : bucketLabel(p.at, 'day')}</td>
                    <td className="py-1.5 text-right">{formatAmount(p.inflow, 'USDC')}</td>
                    <td className="py-1.5 text-right">{formatAmount(p.outflow, 'USDC')}</td>
                    <td className="py-1.5 text-right">{formatAmount((BigInt(p.inflow) - BigInt(p.outflow)).toString(), 'USDC')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <FlowChart series={o.performance.series} bucket={o.bucket} currency="USDC" decimals={6} />
        )}
      </div>
    </Panel>
  );
}
