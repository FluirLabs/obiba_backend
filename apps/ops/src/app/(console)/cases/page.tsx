'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { IconPlus } from '@/components/icons';
import { Dialog, Drawer, useToast } from '@/components/overlay';
import { useSession } from '@/components/shell';
import { DataTable, type Column } from '@/components/table';
import { Amount, Banner, Button, Copyable, cx, Empty, Field, Freshness, KeyValues, LoadError, PageHeader, Select, Skeleton, Status, Tabs, TextArea, TextInput, Time, useTab } from '@/components/ui';
import { api, ApiError, useResource } from '@/lib/api';
import { shortId } from '@/lib/format';
import { HEALTH, SEVERITY, statusLabel } from '@/lib/labels';
import { age } from '@/lib/time';
import type { Incident, IncidentDetail, Overview, ReviewItem } from '@/lib/types';

const REVIEW_LABEL: Record<ReviewItem['type'], string> = {
  deposit: 'Deposit review',
  withdrawal: 'Withdrawal review',
  invoice_payment: 'Invoice payment review',
  sandbox: 'Local service review',
  op_unknown: 'Unknown outcome',
  recovery_failed: 'Failed recovery',
};

function reviewHref(r: ReviewItem): string {
  if (r.type === 'deposit') return `/transactions/deposit/${r.id}`;
  if (r.type === 'withdrawal') return `/transactions/withdrawal/${r.id}`;
  if (r.type === 'invoice_payment') return `/transactions/invoice_deposit/${r.id}`;
  if (r.type === 'sandbox') return `/transactions/local/${r.id}`;
  if (r.type === 'op_unknown') return `/transactions/transfer/${r.id}`;
  return r.uid ? `/customers/${r.uid}` : '/cases';
}

function reviewSeverity(r: ReviewItem): keyof typeof SEVERITY {
  if (r.type === 'op_unknown') return 'HIGH';
  return Date.now() - Date.parse(r.updatedAt) > 24 * 3_600_000 ? 'HIGH' : 'MEDIUM';
}

interface SupportCase {
  id: string;
  status: string;
  displayName: string;
  email: string;
  phone: string;
  accountId: string;
  createdAt: string;
  earliestAt: string;
  verifiedBy: string | null;
  approvedBy: string | null;
}

interface SupportCaseDetail extends SupportCase {
  newPublicKey: string;
  checks: Record<string, boolean>;
  notes: string | null;
  verifiedAt: string | null;
  approvedAt: string | null;
  closedBy: string | null;
  closedReason: string | null;
  requiredChecks: string[];
  reviewHours: number;
  user: { uid: string; handle: string | null; status: string; joinedAt: string; phoneVerifiedAt: string | null };
  account: { accountId: string; status: string };
  devices: { publicKey: string; status: string; initial: boolean; createdAt: string }[];
  chainActivity: { direction: string; counterparty: string; amount: string; at: string }[];
  localActivity: { kind: string; provider: string; status: string; amount: string; at: string }[];
  trail: { at: string; actor: string; action: string; outcome: string }[];
  guardian: { outcome: string; rules: Record<string, unknown>; at: string }[];
}

const CHECKS: Record<string, [string, string]> = {
  called_registered_phone: ['Called the registered number', 'You spoke to the account holder on the saved number, or confirmed it is lost and verified them another way.'],
  id_name_matches: ['Ghana Card name matches the account', 'Seen on a video call. Do not record the card number or keep a photo.'],
  knows_recent_activity: ['Knows recent account activity', 'They described recent payments, amounts or contacts that match the activity shown.'],
};

export default function CasesPage() {
  const tab = useTab(['review', 'restores', 'incidents']);
  const review = useResource<ReviewItem[]>('/v1/review-queue');
  const restores = useResource<SupportCase[]>('/v1/support-cases?status=open');
  const incidents = useResource<{ observedAt: string; rows: Incident[] }>('/v1/ops/incidents?status=open');
  const current = tab === 'review' ? review : tab === 'restores' ? restores : incidents;
  return (
    <>
      <PageHeader title="Cases & incidents" description="Work that needs a person: reviews where automation stopped, account restores under the two-person rule, and incidents from acknowledgement to an evidenced resolution." actions={<Freshness observedAt={incidents.data?.observedAt} refreshing={current.refreshing} onRefresh={current.refresh} />} />
      <Tabs
        tabs={[
          { key: 'review', label: 'Review queue', count: review.data?.length ?? null },
          { key: 'restores', label: 'Account restores', count: restores.data?.length ?? null },
          { key: 'incidents', label: 'Incidents', count: incidents.data?.rows.length ?? null },
        ]}
      />
      {tab === 'review' && <ReviewQueue res={review} />}
      {tab === 'restores' && <Restores res={restores} />}
      {tab === 'incidents' && <Incidents res={incidents} />}
    </>
  );
}

function ReviewQueue({ res }: { res: ReturnType<typeof useResource<ReviewItem[]>> }) {
  const columns: Column<ReviewItem>[] = [
    { key: 'sev', header: 'Severity', width: '100px', cell: (r) => <Status tone={SEVERITY[reviewSeverity(r)]!.tone}>{SEVERITY[reviewSeverity(r)]!.label}</Status>, sort: (r) => SEVERITY[reviewSeverity(r)]!.rank },
    {
      key: 'item',
      header: 'Item',
      cell: (r) => (
        <div>
          <div className="font-medium text-ink">{REVIEW_LABEL[r.type]}</div>
          <div className="font-mono text-[12px] text-muted">{shortId(r.id, 10, 6)}</div>
        </div>
      ),
    },
    { key: 'why', header: 'Why it stopped', cell: (r) => <span className="text-ink-3">{r.type === 'op_unknown' ? 'Submitted, no proven outcome after 10 minutes' : r.type === 'recovery_failed' ? String(r.detail.reason ?? 'Recovery failed') : `Status ${statusLabel(r.status)}`}</span> },
    { key: 'amount', header: 'Amount', align: 'right', cell: (r) => (typeof r.detail.amount === 'string' ? <Amount value={r.detail.amount} currency={r.type === 'sandbox' ? 'DEMO_USDC' : 'USDC'} /> : typeof r.detail.amount_in === 'string' ? <Amount value={r.detail.amount_in} currency="USDC" /> : typeof r.detail.min_amount_out === 'string' ? <Amount value={r.detail.min_amount_out} currency="USDC" /> : <span className="text-subtle">—</span>) },
    { key: 'customer', header: 'Customer', cell: (r) => (r.uid ? <Link href={`/customers/${r.uid}`} className="font-mono text-[12.5px] text-brand-ink hover:underline">{shortId(r.uid, 8, 4)}</Link> : <span className="text-subtle">—</span>) },
    { key: 'waiting', header: 'Waiting', align: 'right', cell: (r) => <span className="tnum text-ink-3">{age(r.updatedAt)}</span>, sort: (r) => r.updatedAt },
  ];
  return (
    <>
      <DataTable
        caption="Review queue"
        columns={columns}
        rows={res.data}
        rowKey={(r) => `${r.type}:${r.id}`}
        rowHref={reviewHref}
        loading={res.loading}
        error={res.error}
        onRetry={res.refresh}
        empty={<Empty title="The review queue is empty">Nothing is waiting for a decision.</Empty>}
      />
      <p className="mt-2 text-xs text-muted">Open an item to inspect provider, chain and ledger evidence and resolve it from the transaction page. Unknown outcomes cannot be resolved by retrying.</p>
    </>
  );
}

function Restores({ res }: { res: ReturnType<typeof useResource<SupportCase[]>> }) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const open = sp.get('case');
  const setOpen = (id: string | null) => {
    const n = new URLSearchParams(sp.toString());
    if (id) n.set('case', id);
    else n.delete('case');
    router.replace(`${pathname}?${n.toString()}`, { scroll: false });
  };
  const columns: Column<SupportCase>[] = [
    { key: 'name', header: 'Account holder', cell: (r) => <div><div className="font-medium text-ink">{r.displayName}</div><div className="max-w-[260px] truncate font-mono text-[12px] text-muted">{r.accountId}</div></div> },
    { key: 'stage', header: 'Stage', cell: (r) => <Stage c={r} /> },
    { key: 'verified', header: 'Verified by', cell: (r) => r.verifiedBy ?? <span className="text-subtle">Not yet</span> },
    { key: 'opened', header: 'Opened', cell: (r) => <Time iso={r.createdAt} short className="text-ink-3" />, sort: (r) => r.createdAt },
    { key: 'earliest', header: 'Earliest move', cell: (r) => <Time iso={r.earliestAt} short className="text-ink-3" />, sort: (r) => r.earliestAt },
  ];
  return (
    <>
      <DataTable caption="Account restores" columns={columns} rows={res.data} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r.id)} selectedKey={open} loading={res.loading} error={res.error} onRetry={res.refresh} empty={<Empty title="No open restore cases">Customers who lose every device and recovery factor open a case from the app or an emailed link.</Empty>} />
      <p className="mt-2 text-xs text-muted">Two-person rule: one operator verifies the person, a different admin approves. The move then waits for the review period and 48 hours on chain, and the customer can cancel from any signed-in device.</p>
      {open && <RestoreDrawer id={open} onClose={() => setOpen(null)} onChanged={res.refresh} />}
    </>
  );
}

function Stage({ c }: { c: { status: string } }) {
  const map: Record<string, [string, 'caution' | 'info' | 'positive' | 'neutral']> = {
    OPEN: ['Needs verification', 'caution'],
    VERIFIED: ['Needs second approval', 'caution'],
    APPROVED: ['In review period', 'info'],
    SUBMITTED: ['Submitted to guardian', 'positive'],
    REJECTED: ['Rejected', 'neutral'],
    CANCELLED: ['Cancelled', 'neutral'],
  };
  const [label, tone] = map[c.status] ?? [statusLabel(c.status), 'neutral'];
  return <Status tone={tone}>{label}</Status>;
}

function RestoreDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const res = useResource<SupportCaseDetail>(`/v1/support-cases/${id}`);
  const { session, can } = useSession();
  const toast = useToast();
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const c = res.data;
  const mine = !!c?.verifiedBy && c.verifiedBy.toLowerCase() === session.email.toLowerCase();
  const act = async (kind: 'verify' | 'approve' | 'reject') => {
    setBusy(kind);
    setError(null);
    try {
      const body = kind === 'verify' ? { checks, notes: text } : kind === 'approve' ? { note: text } : { reason: text };
      await api(`/v1/support-cases/${id}/${kind}`, { method: 'POST', body });
      toast({ tone: 'positive', title: kind === 'verify' ? 'Verification recorded' : kind === 'approve' ? 'Restore approved' : 'Request rejected', body: kind === 'approve' ? 'The guardian is asked to start the move after the review period.' : undefined });
      setText('');
      setRejecting(false);
      res.refresh();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The request failed.');
    } finally {
      setBusy(null);
    }
  };
  const allChecked = c?.requiredChecks.every((k) => checks[k]) ?? false;
  return (
    <Drawer
      open
      onClose={onClose}
      width={620}
      title={c ? c.displayName : 'Account restore'}
      subtitle={c ? <span className="flex items-center gap-2"><Stage c={c} /> · opened <Time iso={c.createdAt} short /></span> : undefined}
      footer={
        c && ['OPEN', 'VERIFIED', 'APPROVED'].includes(c.status) ? (
          rejecting ? (
            <>
              <Button onClick={() => setRejecting(false)}>Back</Button>
              <Button variant="danger-solid" busy={busy === 'reject'} disabled={text.trim().length < 3} onClick={() => act('reject')}>
                Reject request
              </Button>
            </>
          ) : (
            <>
              <Button variant="danger" onClick={() => { setRejecting(true); setText(''); }}>
                Reject
              </Button>
              {c.status === 'OPEN' && can('cases.verify') && (
                <Button variant="primary" busy={busy === 'verify'} disabled={!allChecked || text.trim().length < 3} onClick={() => act('verify')}>
                  Mark verified
                </Button>
              )}
              {c.status === 'VERIFIED' && (
                <Button variant="primary" busy={busy === 'approve'} disabled={mine || !can('cases.approve') || text.trim().length < 3} onClick={() => act('approve')}>
                  Approve restore
                </Button>
              )}
            </>
          )
        ) : undefined
      }
    >
      {!c ? (
        res.error ? <LoadError error={res.error} onRetry={res.refresh} /> : <Skeleton className="h-64 w-full" />
      ) : (
        <div className="space-y-6">
          {rejecting ? (
            <Field label="Reason shown to the account holder" required htmlFor="reject-reason" description="The request ends and the new device is removed. The holder is emailed.">
              <TextArea id="reject-reason" data-autofocus value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
            </Field>
          ) : c.status === 'OPEN' ? (
            <section>
              <h3 className="text-sm font-semibold text-ink">Verify the person</h3>
              <p className="mt-0.5 text-sm text-muted">Confirm every check yourself. A different admin approves after you.</p>
              <div className="mt-3 divide-y divide-hairline rounded-md border border-line">
                {c.requiredChecks.map((k) => (
                  <label key={k} className="flex cursor-pointer gap-3 px-3 py-2.5 hover:bg-hover">
                    <input type="checkbox" className="mt-1 accent-[var(--color-action)]" checked={!!checks[k]} onChange={(e) => setChecks((s) => ({ ...s, [k]: e.target.checked }))} />
                    <span>
                      <span className="block text-sm font-medium text-ink">{CHECKS[k]?.[0] ?? k}</span>
                      <span className="block text-sm text-muted">{CHECKS[k]?.[1]}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-3">
                <Field label="Investigation notes" required htmlFor="verify-notes" description="What you checked and how. Never write ID numbers, codes or passwords.">
                  <TextArea id="verify-notes" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
                </Field>
              </div>
            </section>
          ) : c.status === 'VERIFIED' ? (
            <section>
              {mine ? (
                <Banner tone="caution" title="You verified this case">A different admin must approve it. Separation of duties is enforced by the server.</Banner>
              ) : !can('cases.approve') ? (
                <Banner tone="neutral" title="Approval needs the admin role">Your role can verify and reject, but not approve.</Banner>
              ) : (
                <>
                  <h3 className="text-sm font-semibold text-ink">Approve the restore</h3>
                  <p className="mt-0.5 text-sm text-muted">
                    Verified by {c.verifiedBy}. The move starts after <Time iso={c.earliestAt} /> and then waits 48 hours on NEAR. The holder can cancel from any signed-in device.
                  </p>
                  <div className="mt-3">
                    <Field label="Approval note" required htmlFor="approve-note">
                      <TextArea id="approve-note" value={text} onChange={(e) => setText(e.target.value)} maxLength={300} />
                    </Field>
                  </div>
                </>
              )}
            </section>
          ) : c.status === 'APPROVED' ? (
            <Banner tone="info" title="Waiting for the review period">The guardian is asked to start the move after <Time iso={c.earliestAt} />. It re-checks approvals, session history and the on-chain account.</Banner>
          ) : null}
          {error && <p className="text-sm text-critical" role="alert">{error}</p>}

          <DrawerSection title="Request">
            <KeyValues
              rows={[
                { label: 'Case', value: <Copyable value={c.id} /> },
                { label: 'New device key', value: <Copyable value={c.newPublicKey} display={shortId(c.newPublicKey, 16, 6)} /> },
                { label: 'Verified by', value: c.verifiedBy ? <>{c.verifiedBy}, <Time iso={c.verifiedAt} short /></> : null },
                { label: 'Approved by', value: c.approvedBy ? <>{c.approvedBy}, <Time iso={c.approvedAt} short /></> : null },
                { label: 'Notes', value: c.notes },
              ]}
            />
          </DrawerSection>
          <DrawerSection title="Person">
            <KeyValues
              rows={[
                { label: 'Email', value: c.email },
                { label: 'Registered phone', value: c.phone, hint: c.user.phoneVerifiedAt ? 'SMS verified' : 'Not verified by SMS' },
                { label: 'Customer', value: <Link href={`/customers/${c.user.uid}`} className="text-brand-ink hover:underline">{c.user.handle ? `@${c.user.handle}` : shortId(c.user.uid)}</Link> },
                { label: 'Joined', value: <Time iso={c.user.joinedAt} /> },
              ]}
            />
          </DrawerSection>
          <DrawerSection title="Recent payments on NEAR">
            {c.chainActivity.length === 0 ? (
              <p className="text-sm text-muted">None recorded.</p>
            ) : (
              <ul className="divide-y divide-hairline text-sm">
                {c.chainActivity.map((a, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0 truncate text-ink-3">
                      {a.direction === 'in' ? 'Received from' : 'Sent to'} <span className="font-mono text-[12px]">{shortId(a.counterparty, 14, 6)}</span>
                    </span>
                    <span className="flex items-center gap-3">
                      <Amount value={a.amount} currency="USDC" />
                      <Time iso={a.at} short className="text-xs text-muted" />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </DrawerSection>
          <DrawerSection title="Audit trail">
            {c.trail.length === 0 ? (
              <p className="text-sm text-muted">No entries.</p>
            ) : (
              <ul className="divide-y divide-hairline text-sm">
                {c.trail.map((t, i) => (
                  <li key={i} className="flex justify-between gap-3 py-2">
                    <span>
                      <span className="font-mono text-[12.5px] text-ink-2">{t.action}</span> <span className="text-muted">· {t.actor.replace(/^staff:/, '')}</span>
                    </span>
                    <Time iso={t.at} short className="text-xs text-muted" />
                  </li>
                ))}
              </ul>
            )}
          </DrawerSection>
        </div>
      )}
    </Drawer>
  );
}

function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

const INCIDENT_STAGE: Record<Incident['status'], [string, 'critical' | 'caution' | 'info' | 'positive']> = {
  OPEN: ['Unacknowledged', 'critical'],
  ACKNOWLEDGED: ['Acknowledged', 'caution'],
  INVESTIGATING: ['Investigating', 'info'],
  RESOLVED: ['Resolved', 'positive'],
};

function Incidents({ res }: { res: ReturnType<typeof useResource<{ observedAt: string; rows: Incident[] }>> }) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useSession();
  const [declaringState, setDeclaring] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const resolved = useResource<{ observedAt: string; rows: Incident[] }>(showResolved ? '/v1/ops/incidents?status=RESOLVED' : null);
  const open = sp.get('incident');
  const declaring = declaringState || (sp.get('declare') === '1' && can('incidents.manage'));
  const setOpen = (id: string | null) => {
    const n = new URLSearchParams(sp.toString());
    if (id) n.set('incident', id);
    else n.delete('incident');
    n.delete('declare');
    n.delete('resource');
    router.replace(`${pathname}?${n.toString()}`, { scroll: false });
  };
  const columns: Column<Incident>[] = [
    { key: 'sev', header: 'Severity', width: '100px', cell: (r) => <Status tone={SEVERITY[r.severity]!.tone}>{SEVERITY[r.severity]!.label}</Status>, sort: (r) => SEVERITY[r.severity]!.rank },
    { key: 'title', header: 'Incident', cell: (r) => <div className="min-w-0"><div className="font-medium text-ink">{r.title}</div><div className="max-w-[420px] truncate text-xs text-muted">{r.summary}</div></div> },
    { key: 'stage', header: 'Stage', cell: (r) => <Status tone={INCIDENT_STAGE[r.status][1]}>{INCIDENT_STAGE[r.status][0]}</Status> },
    { key: 'owner', header: 'Owner', cell: (r) => r.owner ?? <span className="font-medium text-critical">Unowned</span> },
    { key: 'age', header: 'Open for', align: 'right', cell: (r) => <span className="tnum text-ink-3">{r.resolvedAt ? `Closed after ${age(r.createdAt, Date.parse(r.resolvedAt))}` : age(r.createdAt)}</span>, sort: (r) => r.createdAt },
  ];
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted">Acknowledging takes ownership; it does not resolve. Resolution needs a recorded decision and fresh evidence.</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setShowResolved((s) => !s)}>
            {showResolved ? 'Hide resolved' : 'Show resolved'}
          </Button>
          {can('incidents.manage') && (
            <Button size="sm" variant="primary" icon={<IconPlus size={14} />} onClick={() => setDeclaring(true)}>
              Declare incident
            </Button>
          )}
        </div>
      </div>
      <DataTable caption="Incidents" columns={columns} rows={res.data ? [...res.data.rows, ...(showResolved ? (resolved.data?.rows ?? []) : [])] : null} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r.id)} selectedKey={open} loading={res.loading} error={res.error} onRetry={res.refresh} empty={<Empty title="No open incidents">Declare one when a signal needs coordinated response. Live signals are on the Overview.</Empty>} />
      <p className="mt-2 text-xs text-muted">External paging is not connected. Incidents here coordinate the response; they do not notify anyone outside the console.</p>
      {declaring && <DeclareDialog onClose={() => { setDeclaring(false); setOpen(null); }} onDone={(id) => { setDeclaring(false); res.refresh(); setOpen(id); }} resource={sp.get('resource')} />}
      {open && <IncidentDrawer id={open} onClose={() => setOpen(null)} onChanged={() => { res.refresh(); resolved.refresh(); }} />}
    </>
  );
}

function DeclareDialog({ onClose, onDone, resource }: { onClose: () => void; onDone: (id: string) => void; resource: string | null }) {
  const { overview } = useSession();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState(resource ? `Affected record ${resource}. ` : '');
  const [severity, setSeverity] = useState('HIGH');
  const [signal, setSignal] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleErr = title.trim().length < 4 ? 'Give the incident a short title.' : null;
  const summaryErr = summary.trim().length < 8 ? 'Describe the impact in at least 8 characters.' : null;
  const submit = async () => {
    setTouched(true);
    if (titleErr || summaryErr) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<Incident>('/v1/ops/incidents', { method: 'POST', body: { title: title.trim(), summary: summary.trim(), severity, signalKey: signal || null, resources: resource ? [resource] : [] } });
      toast({ tone: 'positive', title: 'Incident declared', body: 'It is unowned until someone acknowledges it.' });
      onDone(r.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The request failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title="Declare incident" description="Open a coordinated response. Declaring does not page anyone." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={submit}>Declare incident</Button></>}>
      <div className="space-y-4">
        <Field label="Title" required htmlFor="inc-title" error={touched ? titleErr : null}>
          <TextInput id="inc-title" data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} invalid={touched && !!titleErr} placeholder="e.g. Withdrawals to Base not completing" />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Severity" required htmlFor="inc-sev">
            <Select id="inc-sev" label="Severity" value={severity} onChange={setSeverity} className="w-full" options={['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => ({ value: s, label: SEVERITY[s]!.label }))} />
          </Field>
          <Field label="Linked signal" htmlFor="inc-signal" description="Resolution is blocked while it is critical or stale.">
            <Select id="inc-signal" label="Linked signal" value={signal} onChange={setSignal} className="w-full" options={[{ value: '', label: 'None' }, ...((overview as Overview | null)?.signals ?? []).map((s) => ({ value: s.key, label: `${s.label} · ${HEALTH[s.state].label}` }))]} />
          </Field>
        </div>
        <Field label="Impact and what is known" required htmlFor="inc-summary" error={touched ? summaryErr : null}>
          <TextArea id="inc-summary" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} invalid={touched && !!summaryErr} />
        </Field>
        {error && <p className="text-sm text-critical" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}

function IncidentDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const res = useResource<IncidentDetail>(`/v1/ops/incidents/${id}`);
  const { can } = useSession();
  const toast = useToast();
  const [mode, setMode] = useState<'note' | 'resolve' | 'investigate' | null>(null);
  const [body, setBody] = useState('');
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const i = res.data;
  const act = async (action: 'acknowledge' | 'investigate' | 'note' | 'resolve') => {
    if (!i) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/ops/incidents/${id}/${action}`, { method: 'POST', body: { version: i.updatedAt, body: action === 'acknowledge' ? 'Acknowledged and taking ownership' : body.trim(), evidence: evidence.trim() || undefined } });
      toast({ tone: 'positive', title: action === 'acknowledge' ? 'You own this incident' : action === 'resolve' ? 'Incident resolved' : action === 'investigate' ? 'Investigation started' : 'Note added' });
      setMode(null);
      setBody('');
      setEvidence('');
      res.refresh();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The request failed.');
    } finally {
      setBusy(false);
    }
  };
  const manage = can('incidents.manage') && i && i.status !== 'RESOLVED';
  const valid = body.trim().length >= 3 && (mode !== 'resolve' || evidence.trim().length >= 3);
  return (
    <Drawer
      open
      onClose={onClose}
      width={600}
      title={i?.title ?? 'Incident'}
      subtitle={i ? <span className="flex flex-wrap items-center gap-2"><Status tone={SEVERITY[i.severity]!.tone}>{SEVERITY[i.severity]!.label}</Status> · <Status tone={INCIDENT_STAGE[i.status][1]}>{INCIDENT_STAGE[i.status][0]}</Status> · open {age(i.createdAt, i.resolvedAt ? Date.parse(i.resolvedAt) : undefined)}</span> : undefined}
      footer={
        manage ? (
          mode ? (
            <>
              <Button onClick={() => setMode(null)}>Cancel</Button>
              <Button variant="primary" busy={busy} disabled={!valid} onClick={() => act(mode)}>
                {mode === 'resolve' ? 'Resolve incident' : mode === 'investigate' ? 'Start investigation' : 'Add note'}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => setMode('note')}>Add note</Button>
              {i.status === 'OPEN' && (
                <Button variant="primary" busy={busy} onClick={() => act('acknowledge')}>
                  Acknowledge and own
                </Button>
              )}
              {i.status === 'ACKNOWLEDGED' && <Button variant="primary" onClick={() => setMode('investigate')}>Start investigation</Button>}
              {(i.status === 'ACKNOWLEDGED' || i.status === 'INVESTIGATING') && <Button variant={i.status === 'INVESTIGATING' ? 'primary' : 'secondary'} onClick={() => setMode('resolve')}>Resolve</Button>}
            </>
          )
        ) : undefined
      }
    >
      {!i ? (
        res.error ? <LoadError error={res.error} onRetry={res.refresh} /> : <Skeleton className="h-64 w-full" />
      ) : (
        <div className="space-y-6">
          {mode && (
            <section className="space-y-3 rounded-md border border-line bg-raised p-4">
              <Field label={mode === 'resolve' ? 'Decision' : mode === 'investigate' ? 'Investigation plan' : 'Note'} required htmlFor="inc-body" description={mode === 'resolve' ? 'What was decided and why the condition is over.' : undefined}>
                <TextArea id="inc-body" data-autofocus value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} />
              </Field>
              {(mode === 'resolve' || mode === 'note') && (
                <Field label="Evidence" required={mode === 'resolve'} htmlFor="inc-evidence" description="A reference others can check: transaction hash, reconciliation run time, provider ticket.">
                  <TextInput id="inc-evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={500} />
                </Field>
              )}
            </section>
          )}
          {error && <p className="text-sm text-critical" role="alert">{error}</p>}
          {i.status === 'OPEN' && <Banner tone="critical" title="Nobody owns this incident">Acknowledge it to take ownership. Acknowledging does not resolve it.</Banner>}
          <DrawerSection title="Summary">
            <p className="text-sm text-ink-2">{i.summary}</p>
          </DrawerSection>
          <DrawerSection title="Details">
            <KeyValues
              rows={[
                { label: 'Owner', value: i.owner ?? <span className="font-medium text-critical">Unowned</span> },
                { label: 'Declared by', value: <>{i.declaredBy}, <Time iso={i.createdAt} short /></> },
                { label: 'Linked signal', value: i.signalKey },
                { label: 'Affected records', value: i.resources.length ? i.resources.map((r) => <div key={r} className="font-mono text-[12.5px]">{r}</div>) : null },
                ...(i.resolvedAt ? [{ label: 'Resolved', value: <>{i.resolvedBy}, <Time iso={i.resolvedAt} short /></>, hint: i.resolution ?? undefined }] : []),
              ]}
            />
          </DrawerSection>
          <DrawerSection title="Timeline">
            <ol className="divide-y divide-hairline">
              {i.events.map((e) => (
                <li key={e.id} className="py-2.5">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className={cx('font-medium', e.kind === 'RESOLVED' ? 'text-positive' : 'text-ink')}>{statusLabel(e.kind)}</span>
                    <Time iso={e.at} short className="text-xs text-muted" />
                  </div>
                  <div className="text-xs text-muted">{e.actor}</div>
                  <p className="mt-1 text-sm whitespace-pre-wrap text-ink-3">{e.body}</p>
                  {e.evidence && <div className="mt-1 font-mono text-[12px] break-all text-ink-3">Evidence: {e.evidence}</div>}
                </li>
              ))}
            </ol>
          </DrawerSection>
        </div>
      )}
    </Drawer>
  );
}
