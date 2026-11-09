'use client';

import Link from 'next/link';
import { Amount, Banner, cx, ExternalLink, Freshness, Health, LoadError, NotConfigured, PageHeader, Panel, Section, Skeleton, Status, Time } from '@/components/ui';
import { useSession } from '@/components/shell';
import { useResource } from '@/lib/api';
import { formatUnits } from '@/lib/format';
import { explorerAccount, RECON } from '@/lib/labels';
import { ago } from '@/lib/time';
import type { TreasuryView } from '@/lib/types';

function Line({ label, hint, value, strong, muted }: { label: string; hint?: string; value: React.ReactNode; strong?: boolean; muted?: boolean }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-6 border-b border-hairline px-5 py-3 last:border-b-0">
      <div>
        <div className={cx('text-sm', strong ? 'font-semibold text-ink' : muted ? 'text-muted' : 'text-ink-2')}>{label}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      <div className={cx('text-right', strong && 'font-semibold')}>{value}</div>
    </div>
  );
}

export default function TreasuryPage() {
  const res = useResource<TreasuryView>('/v1/ops/treasury');
  const { session } = useSession();
  const t = res.data;
  return (
    <>
      <PageHeader title="Treasury & liquidity" description="Funds by who controls them, per asset and network. Nothing here is summed across assets, and customer funds are never counted as Obiba backing." actions={<Freshness observedAt={t?.observedAt} refreshing={res.refreshing} onRefresh={res.refresh} />} />
      {res.error && !t && <LoadError error={res.error} onRetry={res.refresh} />}
      {!t ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <>
          <Banner tone="info" className="mb-8" title="Operating model">
            {t.model}
          </Banner>
          {t.assets.map((a) => {
            const reserved = a.reserved.amount;
            const inTransit = a.inTransit.reduce((s, x) => s + BigInt(x.amount), 0n).toString();
            const obiba = (BigInt(a.obibaControlled.treasury) + BigInt(a.obibaControlled.clearing)).toString();
            return (
              <Section key={a.currency} title={`${a.currency} on ${a.network}`} description={<>Coverage evidence <Status tone={RECON[a.verification === 'MISMATCHED' ? 'MISMATCHED' : a.verification]!.tone}>{a.verification === 'MISMATCHED' ? 'Mismatched' : RECON[a.verification]!.label.toLowerCase()}</Status>{a.verifiedAt && <> · last reconciled {ago(a.verifiedAt)}</>}</>}>
                {a.verification !== 'VERIFIED' && (
                  <Banner tone={a.verification === 'MISMATCHED' ? 'critical' : 'caution'} className="mb-4">
                    {a.verification === 'MISMATCHED' ? 'Ledger and chain disagree for at least one account.' : 'Reconciliation is stale, so these balances are unverified.'} Financial approvals that depend on coverage stay blocked until fresh evidence arrives.{' '}
                    <Link href="/ledger?tab=reconciliation" className="font-medium underline">Open reconciliation</Link>
                  </Banner>
                )}
                <div className="grid gap-6 lg:grid-cols-2">
                  <Panel>
                    <div className="border-b border-hairline px-5 py-3">
                      <div className="text-sm font-semibold text-ink">Obiba-controlled</div>
                      <div className="text-xs text-muted">Accounts Obiba operates. The only funds that can back Obiba obligations.</div>
                    </div>
                    <Line label="Treasury" hint="Fees and operating funds" value={<Amount value={a.obibaControlled.treasury} currency={a.currency} />} />
                    <Line label="Payment clearing" hint="obiba-pay contract, between payer and merchant" value={<Amount value={a.obibaControlled.clearing} currency={a.currency} />} />
                    <Line label="Total controlled" value={<Amount value={obiba} currency={a.currency} size="base" />} strong />
                    {a.obibaControlled.accounts.length === 0 && <div className="px-5 py-3 text-xs text-muted">No treasury or clearing movements have been ledgered yet.</div>}
                  </Panel>
                  <Panel>
                    <div className="border-b border-hairline px-5 py-3">
                      <div className="text-sm font-semibold text-ink">Customer-controlled</div>
                      <div className="text-xs text-muted">In customer-owned Smart Accounts. Not Obiba backing and not an Obiba liability.</div>
                    </div>
                    <Line label="Posted in customer accounts" hint={`${a.customerControlled.accounts} accounts`} value={<Amount value={a.customerControlled.posted} currency={a.currency} />} />
                    <Line label="Reserved for pending operations" hint={`${a.reserved.n} active holds`} value={<Amount value={reserved} currency={a.currency} />} />
                    <Line label="In transit" hint={a.inTransit.map((x) => `${x.count} ${x.kind}${x.count === 1 ? '' : 's'}`).join(' · ')} value={<Amount value={inTransit} currency={a.currency} />} />
                    <Line label="Available to customers" hint="Posted minus reserved" value={<Amount value={(BigInt(a.customerControlled.posted) - BigInt(reserved)).toString()} currency={a.currency} size="base" />} strong />
                  </Panel>
                </div>
              </Section>
            );
          })}

          <Section title="Operating accounts" description="Native NEAR balances that keep Obiba running, compared with their funding thresholds.">
            {!t.operatingAccountsConfigured ? (
              <NotConfigured title="No operating accounts monitored">Set WATCH_ACCOUNTS for the operations service to track relayer gas and treasury balances against thresholds.</NotConfigured>
            ) : (
              <Panel className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left">
                  <thead>
                    <tr className="border-b border-line bg-raised text-xs text-muted">
                      <th className="h-9 px-5 font-medium">Account</th>
                      <th className="h-9 px-4 text-right font-medium">Balance</th>
                      <th className="h-9 px-4 text-right font-medium">Threshold</th>
                      <th className="h-9 px-4 font-medium">State</th>
                      <th className="h-9 px-5 text-right font-medium">Observed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.operatingAccounts.map((o) => (
                      <tr key={o.account} className="border-b border-hairline last:border-b-0">
                        <td className="px-5 py-3">
                          <div className="text-sm font-medium text-ink">{o.label}</div>
                          <ExternalLink href={explorerAccount(session.network, o.account)} className="font-mono text-[12px]">{o.account}</ExternalLink>
                        </td>
                        <td className="tnum px-4 py-3 text-right text-sm">{o.amount === null ? <span className="text-subtle">Not observed</span> : `${formatUnits(o.amount, 24, { maxFraction: 4 })} NEAR`}</td>
                        <td className="tnum px-4 py-3 text-right text-sm text-ink-3">{formatUnits(o.threshold, 24, { maxFraction: 2 })} NEAR</td>
                        <td className="px-4 py-3">
                          <Health state={o.state} />
                          {o.state === 'CRITICAL' && <div className="text-xs text-muted">Below funding threshold</div>}
                        </td>
                        <td className="px-5 py-3 text-right text-sm text-muted">{o.observedAt ? <Time iso={o.observedAt} relative /> : 'Never'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )}
          </Section>

          <Section title="Funding and transfer requests">
            <NotConfigured title="Treasury requests are not available in this release">Funding, rebalancing and withdrawal requests need bound approvals and a separate execution service. The console holds no signing credentials and cannot move funds.</NotConfigured>
          </Section>
        </>
      )}
    </>
  );
}
