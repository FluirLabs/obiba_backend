'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ClearFilters, SearchField } from '@/components/filters';
import { Drawer } from '@/components/overlay';
import { useSession } from '@/components/shell';
import { DataTable, Pager, useCursorPages, type Column } from '@/components/table';
import { Amount, Banner, Copyable, cx, Empty, Freshness, KeyValues, LoadError, PageHeader, Panel, Section, Select, Skeleton, Status, Tabs, Time, useTab } from '@/components/ui';
import { qs, useResource } from '@/lib/api';
import { useFilters } from '@/lib/filters';
import { assetLabel, formatAmount, formatCount, shortId } from '@/lib/format';
import { RECON } from '@/lib/labels';
import { age, ago } from '@/lib/time';
import type { Journal, LedgerView, Page, ReconRow } from '@/lib/types';

const KIND_LABEL: Record<string, string> = {
  WALLET: 'Customer accounts',
  EXTERNAL: 'External counterparties',
  TREASURY: 'Obiba treasury',
  CLEARING: 'Payment clearing',
  DEMO_USER: 'Customer pilot balances',
  DEMO_FAUCET: 'Pilot mirror source',
  DEMO_PROVIDER: 'Pilot providers and fees',
};

export default function LedgerPage() {
  const tab = useTab(['reconciliation', 'balances', 'journals', 'holds']);
  const res = useResource<LedgerView>('/v1/ops/ledger');
  const l = res.data;
  return (
    <>
      <PageHeader
        title="Ledger & reconciliation"
        description="Read-only inspection of the double-entry ledger and the controls that prove it. Corrections are never made by editing balances or posted entries."
        actions={<Freshness observedAt={l?.observedAt} refreshing={res.refreshing} onRefresh={res.refresh} label="Computed" />}
      />
      <Tabs
        tabs={[
          { key: 'reconciliation', label: 'Reconciliation', count: l ? l.checks.reduce((s, c) => s + c.exceptions, 0) : null },
          { key: 'balances', label: 'Balances' },
          { key: 'journals', label: 'Journals' },
          { key: 'holds', label: 'Holds', count: l?.holds.length ?? null },
        ]}
      />
      {res.error && !l && <LoadError error={res.error} onRetry={res.refresh} />}
      {tab === 'reconciliation' && <Reconciliation l={l} />}
      {tab === 'balances' && <Balances l={l} />}
      {tab === 'journals' && <Journals />}
      {tab === 'holds' && <Holds l={l} />}
    </>
  );
}

function Reconciliation({ l }: { l: LedgerView | null }) {
  const { can } = useSession();
  if (!l) return <Skeleton className="h-80 w-full" />;
  const chain = l.checks.find((c) => c.key === 'chain');
  const rows = [...l.reconciliation.rows].sort((a, b) => Number(a.matched) - Number(b.matched) || b.checkedAt.localeCompare(a.checkedAt));
  const columns: Column<ReconRow>[] = [
    { key: 'account', header: 'Account', cell: (r) => <Link href={`/customers?q=${encodeURIComponent(r.accountId)}`} className="block max-w-[260px] truncate font-mono text-[12.5px] text-ink-2 hover:text-brand-ink hover:underline" title={r.accountId}>{r.accountId}</Link> },
    { key: 'asset', header: 'Asset and network', cell: (r) => <div><div className="text-ink-2">USDC on NEAR</div><div className="text-xs text-muted" title={r.tokens.join('\n')}>{r.tokens.length} token contract{r.tokens.length === 1 ? '' : 's'}</div></div> },
    { key: 'ledger', header: 'Ledger', align: 'right', cell: (r) => <Amount value={r.ledgerPosted} currency="USDC" showCurrency={false} />, sort: (r) => BigInt(r.ledgerPosted) },
    { key: 'chain', header: 'On chain', align: 'right', cell: (r) => <Amount value={r.chainBalance} currency="USDC" showCurrency={false} />, sort: (r) => BigInt(r.chainBalance) },
    { key: 'diff', header: 'Difference', align: 'right', cell: (r) => (r.difference === '0' ? <span className="tnum text-subtle">0.00</span> : <span className="tnum font-semibold text-critical">{r.difference.startsWith('-') ? '' : '+'}{formatAmount(r.difference, 'USDC')}</span>), sort: (r) => BigInt(r.difference) },
    { key: 'result', header: 'Result', cell: (r) => <Status tone={r.matched ? 'positive' : 'critical'}>{r.matched ? 'Matched' : 'Mismatched'}</Status> },
    { key: 'age', header: 'Mismatched for', cell: (r) => (r.mismatchSince ? <span className="tnum text-critical">{age(r.mismatchSince)}</span> : <span className="text-subtle">—</span>) },
    { key: 'owner', header: 'Owner', cell: (r) => (r.matched ? <span className="text-subtle">—</span> : can('incidents.manage') ? <Link href={`/cases?tab=incidents&declare=1&resource=${encodeURIComponent(`account:${r.accountId}`)}`} className="text-sm font-medium text-brand-ink hover:underline">Unassigned · open incident</Link> : <span className="text-caution">Unassigned</span>) },
    { key: 'checked', header: 'Last checked', cell: (r) => <span className="tnum text-ink-3" title={r.checkedAt}>{ago(r.checkedAt)}</span>, sort: (r) => r.checkedAt },
    { key: 'runs', header: 'Runs', align: 'right', cell: (r) => <span className="tnum text-muted">{formatCount(r.runs)}</span>, hideable: true, label: 'Runs' },
  ];
  return (
    <>
      {chain?.result === 'STALE' && (
        <Banner tone="caution" className="mb-6" title="Chain reconciliation is stale">
          The last run was {chain.observedAt ? ago(chain.observedAt) : 'never'}. Runs are expected every minute; balances below are unverified until the reconciler reports again. Treasury approvals that depend on coverage stay blocked.
        </Banner>
      )}
      <Section title="Controls" description="Each control is computed from authoritative entries at request time. Different assets are never netted against each other.">
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left">
            <thead>
              <tr className="border-b border-line bg-raised text-xs text-muted">
                <th className="h-9 px-5 font-medium">Control</th>
                <th className="h-9 px-4 font-medium">Scope</th>
                <th className="h-9 px-4 font-medium">Result</th>
                <th className="h-9 px-4 text-right font-medium">Checked</th>
                <th className="h-9 px-4 text-right font-medium">Exceptions</th>
                <th className="h-9 px-5 font-medium">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {l.checks.map((c) => (
                <tr key={c.key} className="border-b border-hairline last:border-b-0">
                  <td className="px-5 py-3 text-sm font-medium text-ink">{c.title}</td>
                  <td className="px-4 py-3 text-sm text-ink-3">{c.scope}</td>
                  <td className="px-4 py-3">
                    <Status tone={RECON[c.result]!.tone}>{RECON[c.result]!.label}</Status>
                  </td>
                  <td className="tnum px-4 py-3 text-right text-sm text-ink-3">{formatCount(c.checked)}</td>
                  <td className={cx('tnum px-4 py-3 text-right text-sm', c.exceptions ? 'font-semibold text-critical' : 'text-ink-3')}>{formatCount(c.exceptions)}</td>
                  <td className="px-5 py-3 text-sm text-muted">{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </Section>

      {l.checks.filter((c) => c.rows && c.rows.length > 0).map((c) => (
        <Section key={c.key} title={`Exceptions: ${c.title.toLowerCase()}`}>
          <Panel className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left">
              <thead>
                <tr className="border-b border-line bg-raised text-xs text-muted">
                  <th className="h-9 px-5 font-medium">Ledger account</th>
                  <th className="h-9 px-4 text-right font-medium">Expected</th>
                  <th className="h-9 px-4 text-right font-medium">Recorded</th>
                  <th className="h-9 px-5 text-right font-medium">Difference</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {c.rows!.map((r) => (
                  <tr key={r.account + r.currency} className="border-b border-hairline last:border-b-0">
                    <td className="px-5 py-2.5 font-mono text-[12.5px] text-ink-2">{r.account}</td>
                    <td className="px-4 py-2.5 text-right text-sm">{formatAmount(r.expected, r.currency)}</td>
                    <td className="px-4 py-2.5 text-right text-sm">{formatAmount(r.actual, r.currency)}</td>
                    <td className="px-5 py-2.5 text-right text-sm font-semibold text-critical">
                      {formatAmount(r.difference, r.currency)} {assetLabel(r.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </Section>
      ))}

      <Section title="Chain reconciliation by account" description="Ledger balance compared with the on-chain token balance at the last reconciled block. Mismatches are listed first.">
        <DataTable caption="Chain reconciliation" columns={columns} rows={rows} rowKey={(r) => r.accountId} minWidth={1080} storageKey="recon" empty={<Empty title="No reconciliation runs recorded">The reconciler has not reported for any account. Treat every balance as unverified.</Empty>} />
        <p className="mt-2 text-xs text-muted">Owners are assigned by declaring an incident for the account. Corrections go through an evidenced adjustment request, never by editing balances.</p>
      </Section>
    </>
  );
}

function Balances({ l }: { l: LedgerView | null }) {
  if (!l) return <Skeleton className="h-64 w-full" />;
  const groups = [...new Set(l.totals.map((t) => `${t.domain}|${t.currency}`))];
  return (
    <>
      {groups.map((g) => {
        const [domain, currency] = g.split('|') as [string, string];
        const rows = l.totals.filter((t) => t.domain === domain && t.currency === currency);
        const net = rows.reduce((s, r) => s + BigInt(r.posted), 0n);
        return (
          <Section key={g} title={domain === 'REAL' ? `${assetLabel(currency)} ledger` : `${assetLabel(currency)} · pilot ledger`} description={domain === 'REAL' ? 'Authoritative journal of USDC movements observed on NEAR.' : 'Separate ledger for local services in pilot. Never added to USDC.'}>
            <Panel className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left">
                <thead>
                  <tr className="border-b border-line bg-raised text-xs text-muted">
                    <th className="h-9 px-5 font-medium">Account group</th>
                    <th className="h-9 px-4 text-right font-medium">Accounts</th>
                    <th className="h-9 px-4 text-right font-medium">Posted</th>
                    <th className="h-9 px-5 text-right font-medium">Reserved</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {rows.map((r) => (
                    <tr key={r.kind} className="border-b border-hairline">
                      <td className="px-5 py-2.5 text-sm text-ink-2">
                        {KIND_LABEL[r.kind] ?? r.kind} <span className="ml-1 font-mono text-[11.5px] text-subtle">{r.kind}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-sm text-ink-3">{formatCount(r.accounts)}</td>
                      <td className="px-4 py-2.5 text-right text-sm">{formatAmount(r.posted, currency)}</td>
                      <td className="px-5 py-2.5 text-right text-sm text-ink-3">{r.held === '0' ? '—' : formatAmount(r.held, currency)}</td>
                    </tr>
                  ))}
                  <tr className="bg-raised">
                    <td className="px-5 py-2.5 text-sm font-medium text-ink">Net across all groups</td>
                    <td />
                    <td className={cx('px-4 py-2.5 text-right text-sm font-semibold', net === 0n ? 'text-ink' : 'text-critical')}>{formatAmount(net.toString(), currency)}</td>
                    <td className="px-5 py-2.5 text-right text-sm">
                      <Status tone={net === 0n ? 'positive' : 'critical'}>{net === 0n ? 'Balanced' : 'Out of balance'}</Status>
                    </td>
                  </tr>
                </tbody>
              </table>
            </Panel>
          </Section>
        );
      })}
    </>
  );
}

const JKEYS = ['jq', 'domain'] as const;

function Journals() {
  const [f, set, reset] = useFilters(JKEYS, 'journals');
  const pages = useCursorPages();
  const [open, setOpen] = useState<Journal | null>(null);
  const res = useResource<Page<Journal>>(`/v1/ops/ledger/journals${qs({ q: f.jq, domain: f.domain, cursor: pages.cursor, limit: 50 })}`);
  const { reset: resetPages } = pages;
  useEffect(() => resetPages(), [f.jq, f.domain, resetPages]);
  const columns: Column<Journal>[] = [
    { key: 'id', header: 'Journal', width: '90px', cell: (j) => <span className="tnum font-medium text-ink">#{j.id}</span> },
    { key: 'at', header: 'Posted', cell: (j) => <Time iso={j.createdAt} short className="text-ink-3" /> },
    { key: 'kind', header: 'Kind', cell: (j) => <span className="font-mono text-[12.5px] text-ink-2">{j.kind}</span> },
    { key: 'ledger', header: 'Ledger', cell: (j) => (j.domain === 'REAL' ? 'USDC' : <span className="text-muted">Pilot</span>) },
    { key: 'ref', header: 'Operation reference', cell: (j) => <Copyable value={j.opRef} display={shortId(j.opRef, 18, 6)} /> },
    { key: 'amount', header: 'Amount', align: 'right', cell: (j) => { const d = j.entries.filter((e) => !e.amount.startsWith('-')); const c = d[0]?.currency ?? 'USDC'; return <Amount value={d.reduce((s, e) => s + BigInt(e.amount), 0n).toString()} currency={c} />; } },
    { key: 'lines', header: 'Entries', align: 'right', cell: (j) => <span className="tnum text-muted">{j.entries.length}</span> },
  ];
  return (
    <>
      <DataTable
        caption="Journals"
        columns={columns}
        rows={res.data?.rows ?? null}
        rowKey={(j) => j.id}
        onRowClick={setOpen}
        selectedKey={open?.id}
        loading={res.loading}
        error={res.error}
        onRetry={res.refresh}
        toolbar={
          <>
            <SearchField value={f.jq} onCommit={(jq) => set({ jq })} placeholder="Journal number, operation reference or ledger account" className="max-w-[420px]" />
            <Select label="Ledger" value={f.domain} onChange={(domain) => set({ domain })} options={[{ value: '', label: 'All ledgers' }, { value: 'REAL', label: 'USDC ledger' }, { value: 'DEMO', label: 'Pilot ledger' }]} />
            <ClearFilters active={!!(f.jq || f.domain)} onClear={reset} />
          </>
        }
        footer={res.data && <Pager page={pages.page} count={res.data.rows.length} noun="journals on this page" hasPrev={pages.page > 1} hasNext={!!res.data.nextCursor} onPrev={pages.prev} onNext={() => res.data?.nextCursor && pages.next(res.data.nextCursor)} />}
      />
      {open && (
        <Drawer open onClose={() => setOpen(null)} title={`Journal #${open.id}`} subtitle={<>{open.kind} · <Time iso={open.createdAt} /></>}>
          <KeyValues
            rows={[
              { label: 'Ledger', value: open.domain === 'REAL' ? 'USDC ledger' : 'Pilot ledger' },
              { label: 'Operation reference', value: <Copyable value={open.opRef} /> },
              { label: 'Source', value: open.source ? <pre className="font-mono text-[12px] whitespace-pre-wrap text-ink-3">{JSON.stringify(open.source, null, 2)}</pre> : null },
            ]}
          />
          <h3 className="mt-6 mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">Entries</h3>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th className="h-8 font-medium">Account</th>
                <th className="h-8 text-right font-medium">Debit</th>
                <th className="h-8 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {open.entries.map((e, i) => (
                <tr key={i} className="border-b border-hairline">
                  <td className="py-2 pr-3 text-sm">
                    <div className="font-mono text-[12.5px] break-all text-ink-2">{e.account}</div>
                    <div className="text-xs text-muted">{KIND_LABEL[e.kind] ?? e.kind}</div>
                  </td>
                  <td className="py-2 text-right text-sm">{e.amount.startsWith('-') ? formatAmount(e.amount.slice(1), e.currency) : ''}</td>
                  <td className="py-2 text-right text-sm">{e.amount.startsWith('-') ? '' : formatAmount(e.amount, e.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted">Posted entries are immutable. A correction is a new, approved reversal or adjustment journal linked to this one.</p>
        </Drawer>
      )}
    </>
  );
}

function Holds({ l }: { l: LedgerView | null }) {
  if (!l) return <Skeleton className="h-64 w-full" />;
  const columns: Column<LedgerView['holds'][number]>[] = [
    { key: 'ref', header: 'Hold', cell: (h) => <Copyable value={h.ref} display={shortId(h.ref, 16, 6)} /> },
    { key: 'account', header: 'Ledger account', cell: (h) => <span className="block max-w-[260px] truncate font-mono text-[12.5px] text-ink-3">{h.account}</span> },
    { key: 'amount', header: 'Reserved', align: 'right', cell: (h) => <Amount value={h.amount} currency={h.currency} />, sort: (h) => BigInt(h.amount) },
    { key: 'created', header: 'Reserved at', cell: (h) => <Time iso={h.createdAt} short className="text-ink-3" />, sort: (h) => h.createdAt },
    { key: 'age', header: 'Age', align: 'right', cell: (h) => <span className="tnum text-ink-3">{age(h.createdAt)}</span> },
    { key: 'expires', header: 'Expiry', cell: (h) => (h.expired ? <Status tone="critical">Expired {age(h.expiresAt)} ago</Status> : <Time iso={h.expiresAt} short className="text-ink-3" />), sort: (h) => h.expiresAt },
  ];
  return (
    <>
      <DataTable caption="Active holds" columns={columns} rows={l.holds} rowKey={(h) => h.ref} empty={<Empty title="No active holds">No funds are currently reserved for pending operations.</Empty>} />
      <p className="mt-2 text-xs text-muted">An expired hold does not prove the operation failed. Releasing a hold is not a console action; it follows the operation’s state machine once its outcome is proven.</p>
    </>
  );
}
