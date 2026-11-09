'use client';

import { useState } from 'react';
import { IconPause, IconPlay } from '@/components/icons';
import { Dialog, useToast } from '@/components/overlay';
import { useSession } from '@/components/shell';
import { Banner, Button, Field, Freshness, KeyValues, LoadError, NotConfigured, PageHeader, Panel, Section, Select, Skeleton, Status, Tabs, TextArea, Time, useTab } from '@/components/ui';
import { api, ApiError, useResource } from '@/lib/api';
import { HEALTH, KILL_SWITCH_LABEL } from '@/lib/labels';
import { duration } from '@/lib/time';
import type { SettingsView } from '@/lib/types';

const DURATIONS = [
  { value: '15', label: '15 minutes' },
  { value: '60', label: '1 hour' },
  { value: '240', label: '4 hours' },
  { value: '1440', label: '24 hours' },
  { value: '4320', label: '72 hours (maximum)' },
];

export default function SettingsPage() {
  const tab = useTab(['controls', 'recovery', 'release']);
  const res = useResource<SettingsView>('/v1/ops/settings');
  const s = res.data;
  return (
    <>
      <PageHeader title="Settings & recovery" description="Effective processing controls, release identity and recovery evidence. Secrets are shown only as references." actions={<Freshness observedAt={s?.observedAt} refreshing={res.refreshing} onRefresh={res.refresh} />} />
      <Tabs tabs={[{ key: 'controls', label: 'Processing controls', count: s ? s.controls.switches.filter((x) => x.active).length || null : null }, { key: 'recovery', label: 'Backup and recovery' }, { key: 'release', label: 'Release and configuration' }]} />
      {res.error && !s && <LoadError error={res.error} onRetry={res.refresh} />}
      {!s ? <Skeleton className="h-80 w-full" /> : tab === 'controls' ? <Controls s={s} onChanged={res.refresh} /> : tab === 'recovery' ? <Recovery s={s} /> : <Release s={s} />}
    </>
  );
}

function Controls({ s, onChanged }: { s: SettingsView; onChanged: () => void }) {
  const { can } = useSession();
  const [target, setTarget] = useState<{ name: string; active: boolean } | null>(null);
  if (!s.controls.ok) return <Banner tone="critical" title="Control store unreachable">The current state of processing controls is unknown. Do not assume processing is enabled.</Banner>;
  return (
    <>
      <Banner tone="neutral" className="mb-6">Pausing stops new work of that kind. It cannot cancel anything already submitted to NEAR or a provider. Every pause expires on its own; resuming early needs a reason, and you should check reconciliation first.</Banner>
      <Panel className="divide-y divide-hairline">
        {s.controls.switches.map((k) => {
          const meta = KILL_SWITCH_LABEL[k.name] ?? { title: k.name, effect: '' };
          return (
            <div key={k.name} className="grid items-center gap-4 px-5 py-4 sm:grid-cols-[1fr_180px_auto]">
              <div>
                <div className="text-sm font-semibold text-ink">{meta.title}</div>
                <div className="text-sm text-muted">{meta.effect}</div>
              </div>
              <div>
                {k.active ? <Status tone="critical">Paused</Status> : <Status tone="positive">Running</Status>}
                {k.active && <div className="tnum text-xs text-muted">{k.expiresInSeconds ? `Resumes automatically in ${duration(k.expiresInSeconds * 1000)}` : 'No expiry set'}</div>}
              </div>
              <div className="sm:text-right">
                {can('controls.pause') ? (
                  k.active ? (
                    <Button onClick={() => setTarget({ name: k.name, active: true })} icon={<IconPlay size={13} />}>Resume</Button>
                  ) : (
                    <Button variant="danger" onClick={() => setTarget({ name: k.name, active: false })} icon={<IconPause size={13} />}>Pause</Button>
                  )
                ) : (
                  <span className="text-xs text-muted">Operator role required</span>
                )}
              </div>
            </div>
          );
        })}
      </Panel>
      {target && <ControlDialog target={target} onClose={() => setTarget(null)} onDone={() => { setTarget(null); onChanged(); }} />}
    </>
  );
}

function ControlDialog({ target, onClose, onDone }: { target: { name: string; active: boolean }; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { overview } = useSession();
  const [minutes, setMinutes] = useState('60');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = KILL_SWITCH_LABEL[target.name] ?? { title: target.name, effect: '' };
  const recon = overview?.signals.find((x) => x.key === 'reconciliation');
  const noteErr = note.trim().length < 3 ? 'A reason is required.' : /[^\x20-\x7e]/.test(note) ? 'Use plain characters only.' : null;
  const submit = async () => {
    setTouched(true);
    if (noteErr) return;
    setBusy(true);
    setError(null);
    try {
      if (target.active) await api(`/v1/kill-switches/${target.name}`, { method: 'DELETE', body: { note: note.trim() } });
      else await api(`/v1/kill-switches/${target.name}`, { method: 'PUT', body: { minutes: Number(minutes), note: note.trim() } });
      toast({ tone: target.active ? 'positive' : 'critical', title: target.active ? `${meta.title} resumed` : `${meta.title} paused`, body: 'The control store accepted the change. It is recorded in the audit trail.' });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The request failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      tone={target.active ? undefined : 'critical'}
      title={target.active ? `Resume ${meta.title.toLowerCase()}` : `Pause ${meta.title.toLowerCase()}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={target.active ? 'primary' : 'danger-solid'} busy={busy} onClick={submit}>
            {target.active ? 'Resume now' : `Pause for ${DURATIONS.find((d) => d.value === minutes)?.label}`}
          </Button>
        </>
      }
    >
      <div className="mb-4 rounded-md bg-raised px-4 py-3 text-sm text-ink-3">
        <div className="mb-1 font-medium text-ink-2">Effect</div>
        {target.active ? <p>New {meta.title.toLowerCase()} are accepted again immediately.</p> : <p>{meta.effect} Work already submitted continues and is not cancelled.</p>}
      </div>
      {target.active && recon && recon.state !== 'HEALTHY' && (
        <Banner tone="caution" className="mb-4" title={`Reconciliation is ${HEALTH[recon.state].label.toLowerCase()}`}>
          Resume only after the cause is understood and a fresh reconciliation passes.
        </Banner>
      )}
      <div className="space-y-4">
        {!target.active && (
          <Field label="Duration" required htmlFor="ks-min" description="The pause always ends on its own.">
            <Select id="ks-min" label="Duration" value={minutes} onChange={setMinutes} options={DURATIONS} className="w-full" />
          </Field>
        )}
        <Field label="Reason" required htmlFor="ks-note" error={touched ? noteErr : null}>
          <TextArea id="ks-note" data-autofocus value={note} onChange={(e) => setNote(e.target.value)} invalid={touched && !!noteErr} maxLength={300} />
        </Field>
        {error && <p className="text-sm text-critical" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}

function Recovery({ s }: { s: SettingsView }) {
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <NotConfigured title="Backups">{s.recovery.backups.note}</NotConfigured>
        <NotConfigured title="Restore drill">{s.recovery.restoreDrill.note}</NotConfigured>
        <NotConfigured title="Recovery key custody">{s.recovery.keyCustody.note}</NotConfigured>
      </div>
      <Section title="Policy" className="mt-8">
        <Panel className="px-5 py-4 text-sm text-ink-3">
          {s.recovery.policy} An uploaded backup is not proof that it can be restored; only a passing restore drill is. Decryption material is never displayed here.
        </Panel>
      </Section>
    </>
  );
}

function Release({ s }: { s: SettingsView }) {
  return (
    <div className="grid items-start gap-8 xl:grid-cols-2">
      <Section title="Release">
        <Panel className="px-5 py-2">
          <KeyValues
            rows={[
              { label: 'Release', value: s.release ? <span className="font-mono text-[12.5px]">{s.release}</span> : <Status tone="muted">Not set</Status> },
              { label: 'Business entity', value: s.entity },
              { label: 'Network', value: s.network ? `NEAR ${s.network}` : <Status tone="muted">Not set</Status> },
            ]}
          />
        </Panel>
      </Section>
      <Section title="Configuration references" description="References only. Values are held in Secret Manager and never reach the browser.">
        <Panel className="px-5 py-2">
          <KeyValues rows={s.references.map((r) => ({ label: r.name, value: r.value }))} />
        </Panel>
      </Section>
      <Section title="Applied migrations" className="xl:col-span-2">
        {!s.migrations.ok ? (
          <Banner tone="caution">The migration ledger is not readable by the operations role, so the applied schema version is unknown.</Banner>
        ) : (
          <Panel className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left">
              <thead>
                <tr className="border-b border-line bg-raised text-xs text-muted">
                  <th className="h-9 px-5 font-medium">Migration</th>
                  <th className="h-9 px-5 text-right font-medium">Applied</th>
                </tr>
              </thead>
              <tbody>
                {s.migrations.rows.map((m) => (
                  <tr key={m.name} className="border-b border-hairline last:border-b-0">
                    <td className="px-5 py-2.5 font-mono text-[12.5px] text-ink-2">{m.name}</td>
                    <td className="px-5 py-2.5 text-right text-sm text-ink-3"><Time iso={m.appliedAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </Section>
    </div>
  );
}
