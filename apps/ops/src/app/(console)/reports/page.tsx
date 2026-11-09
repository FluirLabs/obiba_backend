'use client';

import { useState } from 'react';
import { IconDownload } from '@/components/icons';
import { Gated } from '@/components/shell';
import { Banner, Button, Copyable, cx, Field, KeyValues, PageHeader, Panel, Section, TextArea, TextInput, Time } from '@/components/ui';
import { useToast } from '@/components/overlay';
import { api, ApiError } from '@/lib/api';
import { formatCount } from '@/lib/format';
import type { ReportResult } from '@/lib/types';

const REPORTS = [
  { kind: 'transactions', title: 'Transaction performance', body: 'Daily counts and amounts per operation type, outcome and currency. Amounts are integer base units; currencies are never converted or combined.' },
  { kind: 'reconciliation', title: 'Reconciliation runs', body: 'Every ledger-to-chain comparison in the range with the difference, for audit of coverage over time.' },
  { kind: 'access', title: 'Staff access review', body: 'Every staff action in the audit trail, for periodic access reviews.' },
] as const;

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default function ReportsPage() {
  const toast = useToast();
  const [kind, setKind] = useState<string>('transactions');
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [purpose, setPurpose] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  const rangeErr = !from || !to || span < 0 ? 'The end date must be on or after the start date.' : span > 91 ? 'Reports cover at most 92 days.' : null;
  const purposeErr = purpose.trim().length < 8 ? 'State the business purpose in at least 8 characters.' : /[^\x20-\x7e]/.test(purpose) ? 'Use plain characters only.' : null;

  const run = async () => {
    setTouched(true);
    if (rangeErr || purposeErr) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<ReportResult>(`/v1/ops/reports/${kind}`, { method: 'POST', body: { from: `${from}T00:00:00Z`, to: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString(), purpose: purpose.trim() } });
      setResult(r);
      toast({ tone: 'positive', title: 'Report generated', body: `${formatCount(r.rows)} rows. The export is recorded in the audit trail.` });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The request failed.');
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `obiba-${result.kind}-${result.filters.from.slice(0, 10)}-to-${result.filters.to.slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader title="Reports" description="Reproducible exports. Each run records its filters, schema version, source snapshot time and checksum, and the purpose you give is audited." />
      <Gated capability="reports.export">
        <div className="grid items-start gap-8 xl:grid-cols-[420px_minmax(0,1fr)]">
          <Panel>
            <div className="border-b border-hairline px-5 py-3 text-sm font-semibold text-ink">New report</div>
            <div className="space-y-5 px-5 py-5">
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-ink-2">Report</legend>
                <div className="space-y-2">
                  {REPORTS.map((r) => (
                    <label key={r.kind} className={cx('flex cursor-pointer gap-3 rounded-md border px-3 py-2.5', kind === r.kind ? 'border-brand bg-brand-faint' : 'border-line hover:bg-hover')}>
                      <input type="radio" name="report" checked={kind === r.kind} onChange={() => { setKind(r.kind); setResult(null); }} className="mt-1 accent-[var(--color-action)]" />
                      <span>
                        <span className="block text-sm font-medium text-ink">{r.title}</span>
                        <span className="block text-xs text-muted">{r.body}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="grid grid-cols-2 gap-3">
                <Field label="From (UTC)" required htmlFor="r-from" error={touched ? rangeErr : null}>
                  <TextInput id="r-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} invalid={touched && !!rangeErr} />
                </Field>
                <Field label="To (UTC, inclusive)" required htmlFor="r-to">
                  <TextInput id="r-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} invalid={touched && !!rangeErr} />
                </Field>
              </div>
              <Field label="Business purpose" required htmlFor="r-purpose" error={touched ? purposeErr : null} description="Recorded with your identity. Access to a report does not authorize disclosing customer identity.">
                <TextArea id="r-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} invalid={touched && !!purposeErr} maxLength={300} placeholder="e.g. October operations review for finance" />
              </Field>
              {error && <p className="text-sm text-critical" role="alert">{error}</p>}
              <Button variant="primary" className="w-full" busy={busy} onClick={run}>
                Generate report
              </Button>
            </div>
          </Panel>

          <div className="min-w-0">
            {!result ? (
              <Panel className="px-6 py-14 text-center">
                <div className="text-md font-medium text-ink-2">No report generated in this session</div>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted">Exports are delivered to your browser only. No shareable links are created, and nothing is stored after you leave this page.</p>
              </Panel>
            ) : (
              <>
                <Section title={REPORTS.find((r) => r.kind === result.kind)?.title} actions={<Button variant="primary" icon={<IconDownload size={14} />} onClick={download}>Download CSV</Button>}>
                  <Panel className="mb-4 px-5 py-2">
                    <KeyValues
                      cols={2}
                      rows={[
                        { label: 'Rows', value: <span className="tnum">{formatCount(result.rows)}</span> },
                        { label: 'Schema version', value: result.schemaVersion },
                        { label: 'Range', value: `${result.filters.from.slice(0, 10)} to ${result.filters.to.slice(0, 10)} (end exclusive)` },
                        { label: 'Source snapshot', value: <Time iso={result.snapshotAt} /> },
                        { label: 'Generated by', value: result.generatedBy },
                        { label: 'SHA-256', value: <Copyable value={result.sha256} display={`${result.sha256.slice(0, 16)}…`} /> },
                      ]}
                    />
                  </Panel>
                  <Banner tone="neutral" className="mb-4">{result.definition}</Banner>
                  <Panel className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="border-b border-line bg-raised">
                          {result.columns.map((c) => (
                            <th key={c} className="h-9 px-4 font-mono text-[11.5px] font-medium whitespace-nowrap text-muted">{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="tnum">
                        {result.preview.map((r, i) => (
                          <tr key={i} className="border-b border-hairline last:border-b-0">
                            {r.map((v, j) => (
                              <td key={j} className="px-4 py-2 text-sm whitespace-nowrap text-ink-2">{v ?? ''}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {result.rows === 0 && <div className="px-5 py-8 text-center text-sm text-muted">The range contains no rows.</div>}
                  </Panel>
                  {result.rows > result.preview.length && <p className="mt-2 text-xs text-muted">Showing the first {result.preview.length} of {formatCount(result.rows)} rows. The download contains all of them.</p>}
                </Section>
              </>
            )}
          </div>
        </div>
      </Gated>
    </>
  );
}
