'use client';

import { Gated, useSession } from '@/components/shell';
import { Banner, cx, Freshness, LoadError, PageHeader, Panel, Section, Skeleton, Status, Time } from '@/components/ui';
import { useResource } from '@/lib/api';
import { CAPABILITY_LABEL } from '@/lib/labels';
import type { StaffView } from '@/lib/types';

const ROLE_LABEL: Record<string, string> = { viewer: 'Viewer', operator: 'Operator', admin: 'Admin' };

export default function StaffPage() {
  return (
    <>
      <PageHeader title="Staff & access" description="Who can use this console and what each role allows. The server enforces every capability on every request." />
      <Gated capability="staff.read">
        <StaffBody />
      </Gated>
    </>
  );
}

function StaffBody() {
  const res = useResource<StaffView>('/v1/ops/staff');
  const { session } = useSession();
  const s = res.data;
  if (res.error && !s) return <LoadError error={res.error} onRetry={res.refresh} />;
  if (!s) return <Skeleton className="h-96 w-full" />;
  const caps = Object.keys(CAPABILITY_LABEL).filter((c) => s.roles.some((r) => r.capabilities.includes(c)));
  return (
    <>
      <Banner tone="neutral" className="mb-8" title="Membership changes are deployments" actions={<Freshness observedAt={s.observedAt} refreshing={res.refreshing} onRefresh={res.refresh} />}>
        {s.changeProcess} Source: {s.source}.
      </Banner>
      <Section title="Members" description="Last action and denied requests come from the audit trail.">
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left">
            <thead>
              <tr className="border-b border-line bg-raised text-xs text-muted">
                <th className="h-9 px-5 font-medium">Staff member</th>
                <th className="h-9 px-4 font-medium">Role</th>
                <th className="h-9 px-4 font-medium">Last recorded action</th>
                <th className="h-9 px-4 text-right font-medium">Actions</th>
                <th className="h-9 px-5 text-right font-medium">Denied</th>
              </tr>
            </thead>
            <tbody>
              {s.members.map((m) => (
                <tr key={m.email} className="border-b border-hairline last:border-b-0">
                  <td className="px-5 py-3 text-sm font-medium text-ink">
                    {m.email}
                    {m.email === session.email && <span className="ml-2 text-xs font-normal text-muted">You</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-ink-2">{ROLE_LABEL[m.role] ?? m.role}</td>
                  <td className="px-4 py-3 text-sm text-ink-3">{m.lastAction ? <Time iso={m.lastAction} relative /> : <span className="text-subtle">None recorded</span>}</td>
                  <td className="tnum px-4 py-3 text-right text-sm text-ink-3">{m.actions}</td>
                  <td className={cx('tnum px-5 py-3 text-right text-sm', m.denied ? 'font-semibold text-critical' : 'text-ink-3')}>{m.denied}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </Section>
      <Section title="Capabilities by role" description="Separation of duties: the person who verifies a restore cannot approve it, and nobody can grant themselves access from this console.">
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left">
            <thead>
              <tr className="border-b border-line bg-raised text-xs text-muted">
                <th className="h-9 px-5 font-medium">Capability</th>
                {s.roles.map((r) => (
                  <th key={r.role} className="h-9 w-32 px-4 text-center font-medium">{ROLE_LABEL[r.role] ?? r.role}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {caps.map((c) => (
                <tr key={c} className="border-b border-hairline last:border-b-0">
                  <td className="px-5 py-2.5 text-sm text-ink-2">
                    {CAPABILITY_LABEL[c]}
                    <span className="ml-2 font-mono text-[11.5px] text-subtle">{c}</span>
                  </td>
                  {s.roles.map((r) => (
                    <td key={r.role} className="px-4 py-2.5 text-center text-sm">
                      {r.capabilities.includes(c) ? <Status tone="neutral">Allowed</Status> : <span className="text-faint">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </Section>
      <Section title="Session policy">
        <Panel className="px-5 py-4 text-sm text-ink-3">
          Staff authenticate with Google through Identity-Aware Proxy, which enforces the organisation’s MFA policy. Membership is checked on every request, so removing someone from STAFF_ROLES takes effect at their next request. Customer accounts never grant staff access.
        </Panel>
      </Section>
    </>
  );
}
