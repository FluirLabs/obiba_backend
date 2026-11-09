'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Dialog, useToast } from '@/components/overlay';
import { useSession } from '@/components/shell';
import { Amount, Banner, Button, Copyable, cx, Empty, ExternalLink, Field, Freshness, KeyValues, LoadError, PageHeader, Panel, Section, Skeleton, Status, TextArea, Time } from '@/components/ui';
import { api, ApiError, useResource } from '@/lib/api';
import { assetLabel, formatAmount, shortId } from '@/lib/format';
import { counterpartyLabel, explorerAccount, explorerTx, PHASE, statusLabel, TX_TYPE_LABEL, TX_TYPES, type Tone, type TxType } from '@/lib/labels';
import { dateTime, utc } from '@/lib/time';
import type { TxDetail } from '@/lib/types';

const CHAIN: Record<TxDetail['states']['chain']['state'], { label: string; tone: Tone; explain: string }> = {
  OBSERVED: { label: 'Observed in a final block', tone: 'positive', explain: 'The indexer recorded the token transfer from a final NEAR block.' },
  SUBMITTED_NOT_OBSERVED: { label: 'Submitted, not observed', tone: 'caution', explain: 'A transaction hash exists, but the indexer has not yet seen it in a final block. This is not proof of failure.' },
  NO_TRANSFER_FOUND: { label: 'Ingested, no transfer', tone: 'critical', explain: 'The transaction was ingested but contained no matching token transfer.' },
  NOT_SUBMITTED: { label: 'Not on chain', tone: 'muted', explain: 'Nothing has been submitted to NEAR for this operation.' },
};

const LEDGER: Record<TxDetail['states']['ledger']['state'], { label: string; tone: Tone; explain: string }> = {
  POSTED: { label: 'Posted', tone: 'positive', explain: 'A balanced journal is posted. Posted entries are immutable.' },
  RESERVED: { label: 'Funds reserved', tone: 'info', explain: 'An active hold reserves the amount; nothing is posted yet.' },
  RELEASED: { label: 'Hold released', tone: 'neutral', explain: 'The reservation was released without posting.' },
  NOT_POSTED: { label: 'Not posted', tone: 'muted', explain: 'No journal or hold is linked to this operation.' },
};

const LANE: Record<string, string> = { request: 'Request', provider: 'Provider', chain: 'Blockchain', ledger: 'Ledger', control: 'Control' };

const REVIEW_EFFECT: Record<string, Record<string, string>> = {
  deposit: {
    CREDITED: 'Credits the customer only if an unclaimed NEAR transfer of at least the quoted minimum exists. The server re-checks this and refuses otherwise.',
    REFUNDED: 'Records the deposit as refunded. Confirm the refund with the provider first; this action moves no funds.',
    FAILED: 'Closes the deposit without any credit.',
  },
  withdrawal: {
    COMPLETED: 'Records the withdrawal as delivered. Only choose this with destination-chain evidence of delivery to the recipient.',
    REFUNDED: 'Records that the funds returned to the customer account. Confirm the refund transfer first.',
  },
  invoice_payment: {
    COMPLETED: 'Completes the payment. The server requires the invoice to be paid on-chain.',
    REFUNDED: 'Records a refund and releases the invoice so it can be paid again.',
  },
  sandbox: {
    SUCCEEDED: 'Marks the local service as delivered and captures the reserved pilot balance.',
    FAILED: 'Marks the local service as failed and releases the reserved pilot balance.',
  },
};

function nextAction(d: TxDetail, canResolve: boolean): { title: string; body: string } {
  if (d.phase === 'unknown') return { title: 'Investigate. Do not resend.', body: 'Check the relay transaction on the explorer and wait for the indexer. A generic retry is not available because it could pay twice. If the outcome stays unknown, declare an incident.' };
  if (d.review) return canResolve ? { title: 'Resolve the review with evidence', body: 'Choose the outcome the evidence supports. A note is recorded in the audit trail with your identity.' } : { title: 'Awaiting an operator', body: 'Resolving reviews needs the operator role.' };
  if (d.phase === 'review') return { title: 'Escalate', body: 'This review type is resolved outside the console. Declare an incident if it is blocking the customer.' };
  if (d.phase === 'pending') return { title: 'No action needed yet', body: 'Processing continues automatically. It moves to review if it stops.' };
  if (d.phase === 'failed') return { title: 'No action', body: 'No funds moved. The customer can start a new operation.' };
  return { title: 'No action', body: 'This operation reached a final state with evidence.' };
}

function Lane({ label, state, tone, explain, children }: { label: string; state: string; tone: Tone; explain: string; children?: ReactNode }) {
  return (
    <div className="px-5 py-4">
      <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">{label}</div>
      <div className="mt-1.5">
        <Status tone={tone} className="text-md">
          {state}
        </Status>
      </div>
      <p className="mt-1 text-sm text-muted">{explain}</p>
      {children && <div className="mt-3 space-y-1 text-sm text-ink-3">{children}</div>}
    </div>
  );
}

function Sub({ title, count, children, action }: { title: string; count?: number; children: ReactNode; action?: ReactNode }) {
  return (
    <Panel className="mb-6 overflow-hidden">
      <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
        <h2 className="text-sm font-semibold text-ink">
          {title}
          {count !== undefined && <span className="tnum ml-1.5 font-normal text-muted">{count}</span>}
        </h2>
        {action}
      </div>
      {children}
    </Panel>
  );
}

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th className={cx('h-8 px-5 text-xs font-medium whitespace-nowrap text-muted', right && 'text-right')}>{children}</th>;
}

export default function TransactionDetailPage() {
  const params = useParams<{ type: string; id: string }>();
  const type = params.type as TxType;
  const id = decodeURIComponent(params.id);
  const valid = (TX_TYPES as readonly string[]).includes(type);
  const res = useResource<TxDetail>(valid ? `/v1/ops/transactions/${type}/${encodeURIComponent(id)}` : null);
  const { can, session } = useSession();
  const [resolving, setResolving] = useState(false);
  const d = res.data;
  const crumbs = [{ label: 'Transactions', href: '/transactions' }, { label: valid ? TX_TYPE_LABEL[type] : 'Unknown type' }, { label: shortId(id) }];

  if (!valid) return <LoadError error={{ status: 404, message: 'This transaction type does not exist.' }} />;
  if (res.error && !d)
    return (
      <>
        <PageHeader title="Transaction" crumbs={crumbs} />
        <LoadError error={res.error} onRetry={res.refresh} />
      </>
    );
  if (!d)
    return (
      <>
        <PageHeader title={<Skeleton className="h-8 w-56" />} crumbs={crumbs} />
        <Skeleton className="mb-6 h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </>
    );

  const network = d.states.chain.network ?? session.network;
  const phase = PHASE[d.phase];
  const action = nextAction(d, can('review.resolve'));
  const quote = (d.details.quote ?? null) as Record<string, string> | null;
  const fee = quote?.fee_units && quote.fee_units !== '0' ? quote.fee_units : null;
  const net = quote?.amount_units ?? null;

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={
          <span className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <Amount value={d.amount} currency={d.currency} size="hero" />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Status tone={phase.tone} className="text-base">
              {phase.label}
            </Status>
            <span className="text-faint">·</span>
            <span>{TX_TYPE_LABEL[d.type]}</span>
            <span className="text-faint">·</span>
            <span>Status {statusLabel(d.status)}</span>
            <span className="text-faint">·</span>
            <span title={utc(d.createdAt)}>Created {dateTime(d.createdAt)}</span>
          </span>
        }
        actions={
          <>
            <Freshness observedAt={d.observedAt} refreshing={res.refreshing} onRefresh={res.refresh} />
            {d.review && can('review.resolve') && (
              <Button variant="primary" onClick={() => setResolving(true)}>
                Resolve review
              </Button>
            )}
          </>
        }
      />

      {d.attention.length > 0 && (
        <Banner tone={d.phase === 'unknown' ? 'critical' : 'caution'} className="mb-6" title="Why this needs attention">
          <ul className="space-y-0.5">
            {d.attention.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </Banner>
      )}

      <Panel className="mb-8 grid divide-y divide-hairline md:grid-cols-3 md:divide-x md:divide-y-0">
        <Lane label="Provider" state={d.states.provider.status ? statusLabel(d.states.provider.status) : 'Not applicable'} tone={d.states.provider.status ? (/FAIL|REJECT|REFUSED/.test(d.states.provider.status) ? 'critical' : /REVIEW|NOT_COSIGNED/.test(d.states.provider.status) ? 'caution' : 'neutral') : 'muted'} explain={`${d.states.provider.name}. Provider status alone never proves settlement.`}>
          {d.states.provider.updatedAt && (
            <div>
              Updated <Time iso={d.states.provider.updatedAt} />
            </div>
          )}
        </Lane>
        <Lane label="Blockchain" state={CHAIN[d.states.chain.state].label} tone={CHAIN[d.states.chain.state].tone} explain={CHAIN[d.states.chain.state].explain}>
          {d.states.chain.txHashes.map((h) => (
            <div key={h} className="flex items-center justify-between gap-2">
              <Copyable value={h} display={shortId(h, 10, 8)} />
              <ExternalLink href={explorerTx(network, h)} className="text-xs">
                Explorer
              </ExternalLink>
            </div>
          ))}
        </Lane>
        <Lane label="Accounting" state={LEDGER[d.states.ledger.state].label} tone={LEDGER[d.states.ledger.state].tone} explain={LEDGER[d.states.ledger.state].explain}>
          <div className="tnum">
            {d.states.ledger.journals} journal{d.states.ledger.journals === 1 ? '' : 's'} · {d.states.ledger.holds.length ? d.states.ledger.holds.map(statusLabel).join(', ') : 'no hold'}
          </div>
        </Lane>
      </Panel>

      <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <Sub title="Timeline" count={d.timeline.length}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left">
                <thead>
                  <tr className="border-b border-hairline bg-raised">
                    <Th>Time</Th>
                    <Th>Lane</Th>
                    <Th>Event</Th>
                  </tr>
                </thead>
                <tbody>
                  {d.timeline.map((t, i) => (
                    <tr key={i} className="border-b border-hairline align-top last:border-b-0">
                      <td className="w-[190px] px-5 py-2.5 text-sm">
                        <Time iso={t.at} className="text-ink-3" />
                      </td>
                      <td className="w-[110px] px-5 py-2.5 text-sm text-muted">{LANE[t.lane]}</td>
                      <td className="px-5 py-2.5 text-sm">
                        <div className="font-medium text-ink">{t.title}</div>
                        {t.detail && <div className="mt-0.5 font-mono text-[12px] break-all text-muted">{t.detail}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-hairline px-5 py-2 text-xs text-muted">Times shown in your timezone; hover for UTC. Events come from stored records only; gaps mean nothing was recorded, not that nothing happened.</div>
          </Sub>

          <Sub title="Journals" count={d.journals.length}>
            {d.journals.length === 0 ? (
              <Empty title="No journal posted" className="py-8">
                Nothing has been posted to the ledger for this operation.
              </Empty>
            ) : (
              d.journals.map((j) => (
                <div key={j.id} className="border-b border-hairline last:border-b-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-3 pb-1">
                    <div className="text-sm">
                      <span className="font-medium text-ink">Journal {j.id}</span> <span className="text-muted">· {j.kind} · {j.domain === 'DEMO' ? 'Pilot ledger' : 'USDC ledger'}</span>
                    </div>
                    <Time iso={j.createdAt} className="text-xs text-muted" />
                  </div>
                  <div className="px-5 pb-1">
                    <Copyable value={j.opRef} className="text-xs" />
                  </div>
                  <table className="w-full text-left">
                    <thead>
                      <tr>
                        <Th>Account</Th>
                        <Th right>Debit</Th>
                        <Th right>Credit</Th>
                      </tr>
                    </thead>
                    <tbody className="tnum">
                      {j.entries.map((e, i) => (
                        <tr key={i} className="border-t border-hairline">
                          <td className="px-5 py-2 text-sm">
                            <span className="font-mono text-[12.5px] break-all text-ink-2">{e.account}</span>
                            <span className="ml-2 text-xs text-muted">{e.kind}</span>
                          </td>
                          <td className="px-5 py-2 text-right text-sm whitespace-nowrap">{e.amount.startsWith('-') ? formatAmount(e.amount.slice(1), e.currency) : ''}</td>
                          <td className="px-5 py-2 text-right text-sm whitespace-nowrap">{e.amount.startsWith('-') ? '' : formatAmount(e.amount, e.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))
            )}
          </Sub>

          <Sub title="Holds" count={d.holds.length}>
            {d.holds.length === 0 ? (
              <Empty title="No holds" className="py-8" />
            ) : (
              <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-left">
                <thead>
                  <tr className="border-b border-hairline bg-raised">
                    <Th>Reference</Th>
                    <Th right>Amount</Th>
                    <Th>Status</Th>
                    <Th>Created</Th>
                    <Th>Expires</Th>
                  </tr>
                </thead>
                <tbody>
                  {d.holds.map((h) => (
                    <tr key={h.ref} className="border-b border-hairline last:border-b-0">
                      <td className="px-5 py-2.5 text-sm">
                        <Copyable value={h.ref} display={shortId(h.ref, 14, 6)} />
                      </td>
                      <td className="px-5 py-2.5 text-right text-sm">
                        <Amount value={h.amount} currency={h.currency} />
                      </td>
                      <td className="px-5 py-2.5 text-sm">
                        <Status tone={h.status === 'ACTIVE' ? 'info' : 'neutral'}>{statusLabel(h.status)}</Status>
                        {h.closedAt && <div className="text-xs whitespace-nowrap text-muted">Closed <Time iso={h.closedAt} short /></div>}
                      </td>
                      <td className="px-5 py-2.5 text-sm">
                        <Time iso={h.createdAt} className="text-ink-3" />
                      </td>
                      <td className="px-5 py-2.5 text-sm">
                        <Time iso={h.expiresAt} className={h.status === 'ACTIVE' && Date.parse(h.expiresAt) < Date.parse(d.observedAt) ? 'font-medium text-critical' : 'text-ink-3'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </Sub>

          <Sub title="Chain events" count={d.chainEvents.length}>
            {d.chainEvents.length === 0 ? (
              <Empty title="No chain events" className="py-8">
                No token transfer linked to this operation has been observed on NEAR.
              </Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left">
                  <thead>
                    <tr className="border-b border-hairline bg-raised">
                      <Th>Block</Th>
                      <Th>From</Th>
                      <Th>To</Th>
                      <Th right>Amount</Th>
                      <Th>Receipt</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.chainEvents.map((e) => (
                      <tr key={`${e.receiptId}:${e.logIndex}`} className="border-b border-hairline last:border-b-0">
                        <td className="tnum px-5 py-2.5 text-sm text-ink-3">{Number(e.blockHeight).toLocaleString('en-US')}</td>
                        <td className="max-w-[200px] px-5 py-2.5 text-sm">
                          <Copyable value={e.from} display={shortId(e.from, 14, 6)} />
                        </td>
                        <td className="max-w-[200px] px-5 py-2.5 text-sm">
                          <Copyable value={e.to} display={shortId(e.to, 14, 6)} />
                        </td>
                        <td className="px-5 py-2.5 text-right text-sm">
                          <Amount value={e.amount} currency="USDC" />
                        </td>
                        <td className="px-5 py-2.5 text-sm">{e.txHash ? <ExternalLink href={explorerTx(network, e.txHash)}>{shortId(e.receiptId, 6, 4)}</ExternalLink> : <Copyable value={e.receiptId} display={shortId(e.receiptId, 6, 4)} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Sub>

          {(d.jobs.length > 0 || d.guardian.length > 0) && (
            <Sub title="Jobs and co-signing" count={d.jobs.length + d.guardian.length}>
              <ul className="divide-y divide-hairline">
                {d.jobs.map((j) => (
                  <li key={j.id} className="flex items-center justify-between gap-4 px-5 py-2.5 text-sm">
                    <span>
                      <span className="font-mono text-[12.5px] text-ink-2">{j.topic}</span> <span className="text-muted">· outbox {j.id}</span>
                    </span>
                    <span className="text-muted">{j.dispatchedAt ? <>Dispatched <Time iso={j.dispatchedAt} /></> : <Status tone="caution">Not dispatched</Status>}</span>
                  </li>
                ))}
                {d.guardian.map((g, i) => (
                  <li key={i} className="flex items-center justify-between gap-4 px-5 py-2.5 text-sm">
                    <span>
                      Guardian <Status tone={g.outcome === 'SIGNED' ? 'positive' : 'critical'}>{g.outcome === 'SIGNED' ? 'co-signed' : 'refused'}</Status>
                      {Object.entries(g.rules).filter(([, v]) => v === false).length > 0 && <span className="text-muted"> · failed {Object.entries(g.rules).filter(([, v]) => v === false).map(([k]) => k).join(', ')}</span>}
                    </span>
                    <Time iso={g.decidedAt} className="text-muted" />
                  </li>
                ))}
              </ul>
            </Sub>
          )}

          <Sub title="Raw record" action={<span className="text-xs text-muted">Signing material is never returned</span>}>
            <details className="group">
              <summary className="cursor-pointer px-5 py-3 text-sm text-brand-ink hover:underline">Show stored fields</summary>
              <pre className="max-h-96 overflow-auto border-t border-hairline bg-raised px-5 py-4 font-mono text-[12px] leading-5 text-ink-2 scrollbar-thin">{JSON.stringify(d.details, null, 2)}</pre>
            </details>
          </Sub>
        </div>

        <aside className="space-y-6 xl:sticky xl:top-20">
          <Panel>
            <div className="border-b border-hairline px-5 py-3 text-sm font-semibold text-ink">Next permitted action</div>
            <div className="px-5 py-4">
              <div className="text-sm font-semibold text-ink-2">{action.title}</div>
              <p className="mt-1 text-sm text-muted">{action.body}</p>
              {d.review && can('review.resolve') && (
                <Button variant="primary" className="mt-3 w-full" onClick={() => setResolving(true)}>
                  Resolve review
                </Button>
              )}
              {d.phase === 'unknown' && can('incidents.manage') && (
                <Link href={`/cases?tab=incidents&declare=1&resource=${encodeURIComponent(`${d.type}:${d.id}`)}`} className="mt-3 inline-flex h-8 w-full items-center justify-center rounded-md border border-line text-sm font-medium text-ink-2 hover:bg-hover">
                  Declare incident
                </Link>
              )}
            </div>
          </Panel>

          <Panel>
            <div className="border-b border-hairline px-5 py-3 text-sm font-semibold text-ink">Customer</div>
            <div className="px-5 py-2">
              {d.customer ? (
                <KeyValues
                  rows={[
                    { label: 'Name', value: <Link href={`/customers/${d.customer.uid}`} className="font-medium text-brand-ink hover:underline">{d.customer.name}</Link> },
                    { label: 'Handle', value: d.customer.handle ? `@${d.customer.handle}` : null },
                    { label: 'Profile', value: statusLabel(d.customer.status) },
                    { label: 'Account', value: d.customer.accountId ? <ExternalLink href={explorerAccount(network, d.customer.accountId)}><span className="break-all">{d.customer.accountId}</span></ExternalLink> : null, hint: d.customer.accountStatus ? `Account ${statusLabel(d.customer.accountStatus).toLowerCase()}` : undefined },
                  ]}
                />
              ) : (
                <p className="py-2 text-sm text-muted">Not attributed to a customer.</p>
              )}
            </div>
          </Panel>

          <Panel>
            <div className="border-b border-hairline px-5 py-3 text-sm font-semibold text-ink">Amounts</div>
            <div className="px-5 py-2">
              <KeyValues
                rows={[
                  { label: 'Gross', value: <Amount value={d.amount} currency={d.currency} /> },
                  ...(fee ? [{ label: 'Fee', value: <Amount value={fee} currency={d.currency} /> }] : []),
                  ...(net ? [{ label: 'Net to recipient', value: <Amount value={net} currency={d.currency} /> }] : []),
                  ...(quote?.amount_local || quote?.amount_ghs ? [{ label: 'Local amount', value: `${quote.amount_local ?? quote.amount_ghs} ${quote.currency ?? 'GHS'}`, hint: quote.rate ? `Indicative rate ${quote.rate}; not an authoritative amount` : undefined }] : []),
                  { label: 'Accounting unit', value: assetLabel(d.currency), hint: d.currency === 'DEMO_USDC' ? 'Pilot ledger, kept separate from USDC' : 'USDC base units, 6 decimals' },
                ]}
              />
            </div>
          </Panel>

          <Panel>
            <div className="border-b border-hairline px-5 py-3 text-sm font-semibold text-ink">Settlement and evidence</div>
            <div className="space-y-3 px-5 py-4 text-sm">
              <p className="text-ink-3">{d.settlementPolicy}</p>
              {d.evidence ? (
                <div className="rounded-md bg-raised px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-ink-2">{d.evidence.source}</span>
                    <Status tone={d.evidence.verified ? 'positive' : 'caution'}>{d.evidence.verified ? 'Verified' : 'Not verified'}</Status>
                  </div>
                  <div className="mt-0.5 font-mono text-[12px] break-all text-muted">{d.evidence.detail}</div>
                </div>
              ) : (
                <p className="text-muted">No settlement evidence recorded.</p>
              )}
            </div>
          </Panel>

          <Panel>
            <div className="border-b border-hairline px-5 py-3 text-sm font-semibold text-ink">References</div>
            <div className="px-5 py-2">
              <KeyValues
                rows={[
                  { label: 'Operation ID', value: <Copyable value={d.id} display={shortId(d.id, 12, 8)} /> },
                  ...(d.opId && d.opId !== d.id ? [{ label: 'Signed operation', value: <Link href={`/transactions/transfer/${d.opId}`} className="font-mono text-[12.5px] text-brand-ink hover:underline">{shortId(d.opId)}</Link> }] : []),
                  ...(d.reference ? [{ label: 'Provider reference', value: <Copyable value={d.reference} display={shortId(d.reference, 12, 8)} /> }] : []),
                  { label: 'Rail', value: d.rail },
                  { label: 'Counterparty', value: <span className="break-all">{counterpartyLabel(d.type, d.counterparty)}</span> },
                  { label: 'Last change', value: <Time iso={d.updatedAt} /> },
                ]}
              />
            </div>
          </Panel>

          {d.audit.length > 0 && (
            <Panel>
              <div className="border-b border-hairline px-5 py-3 text-sm font-semibold text-ink">Audit</div>
              <ul className="divide-y divide-hairline">
                {d.audit.map((a) => (
                  <li key={a.id} className="px-5 py-2.5 text-sm">
                    <div className="font-mono text-[12.5px] text-ink-2">{a.action}</div>
                    <div className="text-xs text-muted">
                      {a.actor.replace(/^staff:/, '')} · <Time iso={a.at} />
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </aside>
      </div>

      {d.review && <ResolveDialog open={resolving} onClose={() => setResolving(false)} detail={d} onDone={res.refresh} />}
    </>
  );
}

function ResolveDialog({ open, onClose, detail, onDone }: { open: boolean; onClose: () => void; detail: TxDetail; onDone: () => void }) {
  const toast = useToast();
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const review = detail.review!;
  const noteError = note.trim().length < 3 ? 'Describe the evidence you checked (at least 3 characters).' : note.length > 300 ? 'Keep the note under 300 characters.' : /[^\x20-\x7e]/.test(note) ? 'Use plain characters only; line breaks are not stored.' : null;

  const submit = async () => {
    setTouched(true);
    if (!to || noteError) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ status: string }>(`/v1/review/${review.type}/${detail.id}`, { method: 'POST', body: { to, note: note.trim() } });
      toast({ tone: 'positive', title: 'Review recorded', body: `The server accepted the change to ${statusLabel(r.status)}.` });
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
      title="Resolve review"
      description={`${TX_TYPE_LABEL[detail.type]} ${shortId(detail.id)} · ${formatAmount(detail.amount, detail.currency)} ${assetLabel(detail.currency)}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!to} onClick={submit}>
            {to ? `Record ${statusLabel(to).toLowerCase()}` : 'Choose an outcome'}
          </Button>
        </>
      }
    >
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium text-ink-2">Outcome supported by the evidence</legend>
        {review.allowed.map((s) => (
          <label key={s} className={cx('flex cursor-pointer gap-3 rounded-md border px-3 py-2.5', to === s ? 'border-brand bg-brand-faint' : 'border-line hover:bg-hover')}>
            <input type="radio" name="outcome" value={s} checked={to === s} onChange={() => setTo(s)} className="mt-1 accent-[var(--color-action)]" />
            <span>
              <span className="block text-sm font-medium text-ink">{statusLabel(s)}</span>
              <span className="block text-sm text-muted">{REVIEW_EFFECT[review.type]?.[s] ?? 'Records this outcome.'}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="mt-4">
        <Field label="Evidence note" required htmlFor="review-note" error={touched ? noteError : null} description="Recorded in the audit trail with your identity. Never include passwords, codes or ID numbers.">
          <TextArea id="review-note" value={note} onChange={(e) => setNote(e.target.value)} invalid={touched && !!noteError} maxLength={300} placeholder="e.g. 1Click status REFUNDED, refund tx 0x… confirmed on Base" />
        </Field>
      </div>
      <p className="mt-3 text-xs text-muted">The server re-reads the current state and rejects the change if the record moved on since you loaded it.</p>
      {error && (
        <p className="mt-3 text-sm text-critical" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
