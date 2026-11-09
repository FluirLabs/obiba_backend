'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Dialog, useToast } from '@/components/overlay';
import { useSession } from '@/components/shell';
import { DataTable } from '@/components/table';
import { Amount, Banner, Button, Copyable, Empty, ExternalLink, Field, Freshness, KeyValues, LoadError, PageHeader, Panel, Skeleton, Status, TextArea, Time } from '@/components/ui';
import { txColumns } from '@/features/tx-columns';
import { api, ApiError, qs, useResource } from '@/lib/api';
import { shortId } from '@/lib/format';
import { explorerAccount, statusLabel } from '@/lib/labels';
import { dateOnly } from '@/lib/time';
import type { CustomerDetail, Page, TxRow } from '@/lib/types';

function Block({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Panel className="mb-6">
      <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </Panel>
  );
}

export default function CustomerPage() {
  const { uid } = useParams<{ uid: string }>();
  const { can, session } = useSession();
  const res = useResource<CustomerDetail>(`/v1/ops/customers/${encodeURIComponent(uid)}`);
  const tx = useResource<Page<TxRow>>(`/v1/ops/transactions${qs({ uid, limit: 15 })}`);
  const [revealOpen, setRevealOpen] = useState(false);
  const [revealed, setRevealed] = useState<{ email: string; phone: string; until: number } | null>(null);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [pilotOpen, setPilotOpen] = useState(false);
  const [now, setNow] = useState(0);
  const c = res.data;

  useEffect(() => {
    if (!revealed) return;
    const t = window.setInterval(() => {
      setNow(Date.now());
      if (Date.now() > revealed.until) setRevealed(null);
    }, 1000);
    return () => window.clearInterval(t);
  }, [revealed]);

  const crumbs = [{ label: 'Customers', href: '/customers' }, { label: c?.name ?? shortId(uid) }];
  if (res.error && !c)
    return (
      <>
        <PageHeader title="Customer" crumbs={crumbs} />
        <LoadError error={res.error} onRetry={res.refresh} />
      </>
    );
  if (!c)
    return (
      <>
        <PageHeader title={<Skeleton className="h-8 w-48" />} crumbs={crumbs} />
        <Skeleton className="h-72 w-full" />
      </>
    );

  const frozen = c.account?.status === 'frozen';
  const usdc = c.balances.find((b) => b.currency === 'USDC');

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={c.name}
        description={
          <span className="flex flex-wrap items-center gap-x-2">
            {c.handle && <span>@{c.handle}</span>}
            {c.handle && <span className="text-faint">·</span>}
            <span>Customer since {dateOnly(c.createdAt)}</span>
            <span className="text-faint">·</span>
            <Status tone={c.restrictions.length ? 'critical' : 'positive'}>{c.restrictions.length ? `${c.restrictions.length} restriction${c.restrictions.length > 1 ? 's' : ''}` : 'No restrictions'}</Status>
          </span>
        }
        actions={
          <>
            <Freshness observedAt={c.observedAt} refreshing={res.refreshing} onRefresh={res.refresh} />
            {can('pilot.approve') && !c.flags.pilot && <Button onClick={() => setPilotOpen(true)}>Approve pilot access</Button>}
            {can('accounts.restrict') && c.account && (c.account.status === 'active' || frozen) && (
              <Button variant={frozen ? 'secondary' : 'danger'} onClick={() => setFreezeOpen(true)}>
                {frozen ? 'Unfreeze account' : 'Freeze account'}
              </Button>
            )}
          </>
        }
      />

      {c.restrictions.length > 0 && (
        <Banner tone="caution" className="mb-6" title="Active restrictions and their actual effect">
          <ul className="space-y-0.5">
            {c.restrictions.map((r) => (
              <li key={r.kind}>
                <span className="font-medium">{r.kind}.</span> {r.effect}
              </li>
            ))}
          </ul>
        </Banner>
      )}

      <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <Block title="Balances" action={<span className="text-xs text-muted">From the ledger, not the chain</span>}>
            <div className="grid divide-y divide-hairline sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              {[
                { label: 'Posted', value: usdc?.posted, hint: 'Sum of posted journal entries' },
                { label: 'Reserved', value: usdc?.held, hint: 'Active holds for pending operations' },
                { label: 'Available', value: usdc?.available, hint: 'Posted minus reserved' },
              ].map((m) => (
                <div key={m.label} className="px-5 py-4">
                  <div className="text-sm text-muted">{m.label}</div>
                  <div className="mt-1">{m.value === undefined ? <span className="text-lg text-subtle">No ledger account</span> : <Amount value={m.value} currency="USDC" size="xl" />}</div>
                  <div className="mt-1 text-xs text-muted">{m.hint}</div>
                </div>
              ))}
            </div>
            {c.localBalances.length > 0 && (
              <div className="border-t border-hairline px-5 py-3 text-sm text-ink-3">
                Pilot ledger balance{' '}
                {c.localBalances.map((b) => (
                  <Amount key={b.currency} value={b.available} currency={b.currency} className="font-medium" />
                ))}
                <span className="text-muted"> · kept separately from USDC and never added to it</span>
              </div>
            )}
            {c.account?.lastReconciliation && (
              <div className="border-t border-hairline px-5 py-3 text-sm text-muted">
                Last chain reconciliation{' '}
                <Status tone={c.account.lastReconciliation.matched ? 'positive' : 'critical'}>{c.account.lastReconciliation.matched ? 'matched' : 'did not match'}</Status> · <Time iso={c.account.lastReconciliation.checkedAt} relative />
              </div>
            )}
          </Block>

          <div className="mb-6">
            <div className="mb-3 flex items-end justify-between">
              <h2 className="text-md font-semibold text-ink">Transactions</h2>
              <Link href={`/transactions?uid=${encodeURIComponent(c.uid)}`} className="text-sm text-brand-ink hover:underline">
                View all with filters
              </Link>
            </div>
            <DataTable
              caption="Customer transactions"
              columns={txColumns.filter((col) => ['created', 'type', 'counterparty', 'amount', 'status'].includes(col.key)).map((col) => ({ ...col, hideable: false }))}
              rows={tx.data?.rows ?? null}
              rowKey={(r) => `${r.type}:${r.id}`}
              rowHref={(r) => `/transactions/${r.type}/${encodeURIComponent(r.id)}`}
              loading={tx.loading}
              error={tx.error}
              onRetry={tx.refresh}
              minWidth={640}
              empty={<Empty title="No transactions">This customer has no recorded operations.</Empty>}
            />
          </div>

          <Block title="Cases and recoveries">
            {c.cases.length + c.recoveries.length === 0 ? (
              <Empty title="No cases or recoveries" className="py-8" />
            ) : (
              <ul className="divide-y divide-hairline">
                {c.cases.map((k) => (
                  <li key={k.id}>
                    <Link href={`/cases?tab=restores&case=${k.id}`} className="flex items-center justify-between gap-4 px-5 py-3 hover:bg-hover">
                      <div>
                        <div className="text-sm font-medium text-ink">{k.kind}</div>
                        <div className="text-xs text-muted">
                          Opened <Time iso={k.createdAt} short /> · via {k.source === 'email_link' ? 'email link' : 'app'}
                          {k.verifiedBy && ` · verified by ${k.verifiedBy}`}
                        </div>
                      </div>
                      <Status tone={['OPEN', 'VERIFIED', 'APPROVED'].includes(k.status) ? 'caution' : 'neutral'}>{statusLabel(k.status)}</Status>
                    </Link>
                  </li>
                ))}
                {c.recoveries.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-4 px-5 py-3">
                    <div>
                      <div className="text-sm font-medium text-ink">Recovery by {r.method.toLowerCase()}</div>
                      <div className="text-xs text-muted">
                        <Time iso={r.createdAt} short />
                        {r.reason && ` · ${r.reason}`}
                      </div>
                    </div>
                    <Status tone={r.status === 'FAILED' ? 'critical' : r.status === 'COMPLETED' ? 'positive' : 'neutral'}>{statusLabel(r.status)}</Status>
                  </li>
                ))}
              </ul>
            )}
          </Block>

          <Block title="Device keys" action={<span className="text-xs text-muted">Public keys only</span>}>
            {c.devices.length === 0 ? (
              <Empty title="No devices registered" className="py-8" />
            ) : (
              <ul className="divide-y divide-hairline">
                {c.devices.map((d) => (
                  <li key={d.publicKey} className="flex items-center justify-between gap-4 px-5 py-3">
                    <div className="min-w-0">
                      <Copyable value={d.publicKey} display={shortId(d.publicKey, 16, 6)} />
                      <div className="text-xs text-muted">
                        Added <Time iso={d.createdAt} short />
                        {d.initial && ' · first device'}
                      </div>
                    </div>
                    <Status tone={d.status === 'active' ? 'positive' : d.status === 'revoked' ? 'muted' : 'caution'}>{statusLabel(d.status)}</Status>
                  </li>
                ))}
              </ul>
            )}
          </Block>
        </div>

        <aside className="space-y-6 xl:sticky xl:top-20">
          <Panel>
            <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
              <h2 className="text-sm font-semibold text-ink">Contact</h2>
              {revealed ? (
                <span className="tnum text-xs text-caution">Visible for {Math.max(0, Math.ceil((revealed.until - now) / 1000))}s</span>
              ) : (
                can('customers.reveal') && (
                  <Button size="sm" variant="ghost" onClick={() => setRevealOpen(true)}>
                    Reveal
                  </Button>
                )
              )}
            </div>
            <div className="px-5 py-2">
              <KeyValues
                rows={[
                  { label: 'Email', value: <span className={revealed ? 'font-medium text-ink' : 'tnum'}>{revealed?.email ?? c.email}</span> },
                  { label: 'Phone', value: <span className={revealed ? 'tnum font-medium text-ink' : 'tnum'}>{revealed?.phone ?? c.phone}</span> },
                  { label: 'Customer ID', value: <Copyable value={c.uid} display={shortId(c.uid, 10, 4)} /> },
                ]}
              />
            </div>
          </Panel>

          <Panel>
            <div className="border-b border-hairline px-5 py-3 text-sm font-semibold text-ink">Verification</div>
            <div className="px-5 py-2">
              <KeyValues
                rows={[
                  { label: 'Email', value: c.verification.email },
                  { label: 'Phone', value: c.verification.phone },
                  { label: 'Financial identity', value: c.verification.identity },
                  { label: 'Recovery kit', value: c.verification.recoveryKit },
                ]}
              />
            </div>
          </Panel>

          <Panel>
            <div className="border-b border-hairline px-5 py-3 text-sm font-semibold text-ink">Account and custody</div>
            <div className="px-5 py-2">
              {c.account ? (
                <KeyValues
                  rows={[
                    { label: 'NEAR account', value: <ExternalLink href={explorerAccount(session.network, c.account.id)}><span className="break-all">{c.account.id}</span></ExternalLink> },
                    { label: 'Status', value: <Status tone={c.account.status === 'active' ? 'positive' : 'critical'}>{statusLabel(c.account.status)}</Status> },
                    { label: 'Custody', value: c.account.custody },
                    { label: 'Created', value: <Time iso={c.account.createdAt} /> },
                  ]}
                />
              ) : (
                <p className="py-3 text-sm text-muted">No NEAR account has been provisioned.</p>
              )}
            </div>
          </Panel>

          <Panel>
            <div className="border-b border-hairline px-5 py-3 text-sm font-semibold text-ink">Access</div>
            <div className="px-5 py-2">
              <KeyValues
                rows={[
                  { label: 'Profile', value: statusLabel(c.status) },
                  { label: 'Pilot access', value: c.flags.pilot ? 'Approved' : <Status tone="caution">Awaiting approval</Status> },
                  { label: 'Merchant', value: c.flags.merchant ? 'Yes' : 'No' },
                  { label: 'Internal tester', value: c.flags.internalTester ? 'Yes' : 'No' },
                ]}
              />
            </div>
          </Panel>
          <p className="text-xs text-muted">Staff cannot view or set passwords, sign in as the customer, or move customer funds. Account access recovery runs through the restore case workflow.</p>
        </aside>
      </div>

      <RevealDialog open={revealOpen} onClose={() => setRevealOpen(false)} uid={c.uid} name={c.name} onRevealed={(r) => {
          const t = Date.now();
          setNow(t);
          setRevealed({ email: r.email, phone: r.phone, until: t + r.expiresInSeconds * 1000 });
        }} />
      {c.account && <FreezeDialog open={freezeOpen} onClose={() => setFreezeOpen(false)} accountId={c.account.id} frozen={frozen} name={c.name} onDone={res.refresh} />}
      <PilotDialog open={pilotOpen} onClose={() => setPilotOpen(false)} uid={c.uid} name={c.name} onDone={res.refresh} />
    </>
  );
}

function useReason(min: number, max: number) {
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const v = value.trim();
  const error = v.length < min ? `Give a reason of at least ${min} characters.` : v.length > max ? `Keep it under ${max} characters.` : /[^\x20-\x7e]/.test(v) ? 'Use plain characters only.' : null;
  return { value, setValue, touched, setTouched, error, reset: () => { setValue(''); setTouched(false); } };
}

function RevealDialog({ open, onClose, uid, name, onRevealed }: { open: boolean; onClose: () => void; uid: string; name: string; onRevealed: (r: { email: string; phone: string; expiresInSeconds: number }) => void }) {
  const reason = useReason(8, 300);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    reason.setTouched(true);
    if (reason.error) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ email: string; phone: string; expiresInSeconds: number }>(`/v1/ops/customers/${encodeURIComponent(uid)}/reveal`, { method: 'POST', body: { reason: reason.value.trim() } });
      onRevealed(r);
      reason.reset();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The request failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Reveal contact details"
      description={`Email and phone number for ${name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            Reveal for 2 minutes
          </Button>
        </>
      }
    >
      <Field label="Business reason" required htmlFor="reveal-reason" error={reason.touched ? reason.error : null} description="Recorded with your identity in the audit trail. Example: calling the customer about support case 7f0b1b03.">
        <TextArea id="reveal-reason" data-autofocus value={reason.value} onChange={(e) => reason.setValue(e.target.value)} invalid={reason.touched && !!reason.error} maxLength={300} />
      </Field>
      {error && <p className="mt-3 text-sm text-critical" role="alert">{error}</p>}
    </Dialog>
  );
}

function FreezeDialog({ open, onClose, accountId, frozen, name, onDone }: { open: boolean; onClose: () => void; accountId: string; frozen: boolean; name: string; onDone: () => void }) {
  const toast = useToast();
  const note = useReason(3, 300);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    note.setTouched(true);
    if (note.error) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/accounts/${encodeURIComponent(accountId)}/status`, { method: 'POST', body: { status: frozen ? 'active' : 'frozen', note: note.value.trim() } });
      toast({ tone: 'positive', title: frozen ? 'Account unfrozen' : 'Account frozen', body: `The server recorded the change for ${accountId}.` });
      note.reset();
      onClose();
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The request failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      tone={frozen ? undefined : 'critical'}
      title={frozen ? 'Unfreeze account' : 'Freeze account'}
      description={`${name} · ${accountId}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={frozen ? 'primary' : 'danger-solid'} busy={busy} onClick={submit}>
            {frozen ? 'Unfreeze account' : 'Freeze account'}
          </Button>
        </>
      }
    >
      <div className="mb-4 rounded-md bg-raised px-4 py-3 text-sm text-ink-3">
        <div className="mb-1 font-medium text-ink-2">Effect</div>
        {frozen ? (
          <p>Obiba resumes relaying and co-signing new operations for this account. The customer is notified in the app.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-4">
            <li>Obiba stops relaying and co-signing new operations for this account.</li>
            <li>Transactions already submitted to NEAR are not cancelled.</li>
            <li>The funds stay in the customer-owned account; Obiba cannot move them.</li>
          </ul>
        )}
      </div>
      <Field label="Reason" required htmlFor="freeze-note" error={note.touched ? note.error : null} description="Recorded in the audit trail.">
        <TextArea id="freeze-note" data-autofocus value={note.value} onChange={(e) => note.setValue(e.target.value)} invalid={note.touched && !!note.error} maxLength={300} />
      </Field>
      {error && <p className="mt-3 text-sm text-critical" role="alert">{error}</p>}
    </Dialog>
  );
}

function PilotDialog({ open, onClose, uid, name, onDone }: { open: boolean; onClose: () => void; uid: string; name: string; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/pilot/${encodeURIComponent(uid)}`, { method: 'POST', body: { allowed: true } });
      toast({ tone: 'positive', title: 'Pilot access approved', body: `${name} can now use Obiba.` });
      onClose();
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The request failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Approve pilot access" description={name} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={submit}>Approve access</Button></>}>
      <p className="text-sm text-ink-3">The customer can sign in, receive USDC and use pilot services. This is recorded in the audit trail.</p>
      {error && <p className="mt-3 text-sm text-critical" role="alert">{error}</p>}
    </Dialog>
  );
}
