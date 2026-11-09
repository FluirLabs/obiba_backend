'use client';

import Link from 'next/link';
import { Banner, cx, Empty, Freshness, LoadError, NotConfigured, PageHeader, Panel, Section, Skeleton, Status, Time } from '@/components/ui';
import { useResource } from '@/lib/api';
import { formatCount, shortId } from '@/lib/format';
import { statusLabel } from '@/lib/labels';
import { age } from '@/lib/time';
import type { JobsView } from '@/lib/types';

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={cx('h-9 px-5 text-xs font-medium whitespace-nowrap text-muted', right && 'text-right')}>{children}</th>;
}

export default function JobsPage() {
  const res = useResource<JobsView>('/v1/ops/jobs');
  const j = res.data;
  return (
    <>
      <PageHeader title="Jobs & infrastructure" description="Background processing, queue depth and chain ingestion. Missing evidence of liveness is shown as unknown, not healthy." actions={<Freshness observedAt={j?.observedAt} refreshing={res.refreshing} onRefresh={res.refresh} />} />
      {res.error && !j && <LoadError error={res.error} onRetry={res.refresh} />}
      {!j ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <>
          {!j.queues.ok && <Banner tone="critical" className="mb-6" title="Queue store unreachable">Queue depth and failures are unknown.</Banner>}
          <Section title="Liveness">
            <div className="grid gap-4 lg:grid-cols-2">
              <NotConfigured title="Worker, indexer and scheduler heartbeats">{j.heartbeats.note}</NotConfigured>
              <Panel className="px-5 py-4">
                <div className="flex items-baseline justify-between">
                  <div className="text-sm font-semibold text-ink-2">Worker connections</div>
                  {j.queues.workerConnections === null ? <Status tone="muted">Unknown</Status> : <Status tone="positive">{j.queues.workerConnections} connected</Status>}
                </div>
                <p className="mt-1 text-sm text-muted">Counted from named queue-store clients. Managed Redis may hide client names, so zero visible is not proof of an outage.</p>
              </Panel>
            </div>
          </Section>

          <Section title="Queues">
            <Panel className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left">
                <thead>
                  <tr className="border-b border-line bg-raised">
                    <Th>Queue</Th>
                    <Th right>Waiting</Th>
                    <Th right>Active</Th>
                    <Th right>Delayed</Th>
                    <Th right>Failed, retained</Th>
                    <Th>Last completion</Th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {j.queues.queues.map((q) => (
                    <tr key={q.queue} className="border-b border-hairline last:border-b-0">
                      <td className="px-5 py-3 font-mono text-[12.5px] text-ink-2">{q.queue}</td>
                      <td className="px-5 py-3 text-right text-sm">{formatCount(q.waiting)}</td>
                      <td className="px-5 py-3 text-right text-sm">{formatCount(q.active)}</td>
                      <td className="px-5 py-3 text-right text-sm">{formatCount(q.delayed)}</td>
                      <td className={cx('px-5 py-3 text-right text-sm', q.failed ? 'font-semibold text-critical' : '')}>{formatCount(q.failed)}</td>
                      <td className="px-5 py-3 text-sm text-ink-3">{q.lastCompletedAt ? <><Time iso={q.lastCompletedAt} relative /></> : <span className="text-subtle">Never</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </Section>

          <Section title="Outbox dispatch" description="Jobs written in the same transaction as the business change, then dispatched to the queues.">
            <Panel className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left">
                <thead>
                  <tr className="border-b border-line bg-raised">
                    <Th>Topic</Th>
                    <Th right>Undispatched</Th>
                    <Th>Oldest undispatched</Th>
                    <Th right>Dispatched, 24h</Th>
                    <Th>Last dispatched</Th>
                    <Th right>Total</Th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {j.outbox.map((o) => (
                    <tr key={o.topic} className="border-b border-hairline last:border-b-0">
                      <td className="px-5 py-3 font-mono text-[12.5px] text-ink-2">{o.topic}</td>
                      <td className={cx('px-5 py-3 text-right text-sm', o.pending ? 'font-semibold text-caution' : '')}>{formatCount(o.pending)}</td>
                      <td className="px-5 py-3 text-sm">{o.oldest ? <span className="text-caution">{age(o.oldest)}</span> : <span className="text-subtle">—</span>}</td>
                      <td className="px-5 py-3 text-right text-sm">{formatCount(o.dispatched24h)}</td>
                      <td className="px-5 py-3 text-sm text-ink-3"><Time iso={o.lastDispatched} relative /></td>
                      <td className="px-5 py-3 text-right text-sm text-muted">{formatCount(o.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {j.outbox.length === 0 && <Empty title="No jobs have been written yet" />}
            </Panel>
          </Section>

          <Section title="Chain ingestion">
            <Panel className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left">
                <thead>
                  <tr className="border-b border-line bg-raised">
                    <Th>Stream</Th>
                    <Th right>Cursor</Th>
                    <Th right>Final head</Th>
                    <Th right>Lag</Th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {j.streams.map((s) => (
                    <tr key={s.stream} className="border-b border-hairline last:border-b-0">
                      <td className="px-5 py-3 font-mono text-[12.5px] text-ink-2">{s.stream}</td>
                      <td className="px-5 py-3 text-right text-sm">{Number(s.height).toLocaleString('en-US')}</td>
                      <td className="px-5 py-3 text-right text-sm">{s.head ? s.head.toLocaleString('en-US') : <span className="text-subtle">Not observed</span>}</td>
                      <td className="px-5 py-3 text-right text-sm">{s.lag === null ? <Status tone="muted">Unknown</Status> : <Status tone={s.lag > 600 ? 'critical' : s.lag > 120 ? 'caution' : 'positive'}>{s.lag.toLocaleString('en-US')} blocks</Status>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </Section>

          <Section title="Operations stuck after submission" description="Submitted, relayed or unknown for more than 10 minutes. Investigate each; none can be resent from here.">
            <Panel>
              {j.stuck.length === 0 ? (
                <Empty title="Nothing is stuck" />
              ) : (
                <ul className="divide-y divide-hairline">
                  {j.stuck.map((s) => (
                    <li key={s.opId}>
                      <Link href={`/transactions/transfer/${s.opId}`} className="grid grid-cols-[1fr_auto_auto] items-center gap-6 px-5 py-3 hover:bg-hover">
                        <span className="font-mono text-[12.5px] text-ink-2">{shortId(s.opId, 12, 8)}</span>
                        <Status tone={s.status === 'UNKNOWN' ? 'critical' : 'caution'}>{statusLabel(s.status)}</Status>
                        <span className="tnum text-sm text-muted">{age(s.since)} · {s.attempts} relay attempts</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </Section>

          <Section title="Recent failures" description="Error text is sanitized: addresses, identifiers and URLs are removed.">
            <Panel>
              {j.queues.queues.every((q) => q.failures.length === 0) ? (
                <Empty title="No retained failures" />
              ) : (
                <ul className="divide-y divide-hairline">
                  {j.queues.queues.flatMap((q) => q.failures.map((f, i) => (
                    <li key={`${q.queue}-${i}`} className="grid grid-cols-[180px_1fr_auto] gap-4 px-5 py-3 text-sm">
                      <span className="font-mono text-[12.5px] text-ink-2">{f.job}</span>
                      <span className="text-ink-3">{f.error}</span>
                      <span className="tnum text-muted">{f.attempts} attempts · <Time iso={f.at} relative /></span>
                    </li>
                  )))}
                </ul>
              )}
            </Panel>
            <p className="mt-2 text-xs text-muted">{j.retryPolicy}</p>
          </Section>
        </>
      )}
    </>
  );
}
