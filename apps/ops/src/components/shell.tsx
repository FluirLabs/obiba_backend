'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, qs, setDevStaff, useDevStaff, useResource } from '@/lib/api';
import { assetLabel, formatAmount, shortId } from '@/lib/format';
import { HEALTH, PHASE, SEVERITY, TX_TYPE_LABEL } from '@/lib/labels';
import { ago, age } from '@/lib/time';
import type { CustomerRow, Overview, Page, Session, TxRow } from '@/lib/types';
import {
  IconAudit,
  IconBell,
  IconCases,
  IconChevronDown,
  IconCustomers,
  IconJobs,
  IconLedger,
  IconLogout,
  IconMenu,
  IconOverview,
  IconProviders,
  IconReports,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconStaff,
  IconTransactions,
  IconTreasury,
} from './icons';
import { Popover, ToastProvider } from './overlay';
import { Button, cx, Spinner, Status } from './ui';

interface Ctx {
  session: Session;
  overview: Overview | null;
  overviewAt: number | null;
  refreshOverview: () => void;
  can: (capability: string) => boolean;
}

const SessionCtx = createContext<Ctx | null>(null);

export function useSession(): Ctx {
  const c = useContext(SessionCtx);
  if (!c) throw new Error('session missing');
  return c;
}

const NAV: { group: string | null; items: { href: string; label: string; icon: (p: { size?: number }) => ReactNode; cap?: string }[] }[] = [
  { group: null, items: [{ href: '/', label: 'Overview', icon: IconOverview }] },
  {
    group: 'Operations',
    items: [
      { href: '/transactions', label: 'Transactions', icon: IconTransactions },
      { href: '/customers', label: 'Customers', icon: IconCustomers },
      { href: '/cases', label: 'Cases & incidents', icon: IconCases },
    ],
  },
  {
    group: 'Financial',
    items: [
      { href: '/ledger', label: 'Ledger & reconciliation', icon: IconLedger },
      { href: '/treasury', label: 'Treasury & liquidity', icon: IconTreasury },
      { href: '/reports', label: 'Reports', icon: IconReports, cap: 'reports.export' },
    ],
  },
  {
    group: 'Infrastructure',
    items: [
      { href: '/providers', label: 'Providers & networks', icon: IconProviders },
      { href: '/jobs', label: 'Jobs & infrastructure', icon: IconJobs },
    ],
  },
  {
    group: 'Administration',
    items: [
      { href: '/staff', label: 'Staff & access', icon: IconStaff, cap: 'staff.read' },
      { href: '/audit', label: 'Audit trail', icon: IconAudit, cap: 'audit.read' },
      { href: '/settings', label: 'Settings & recovery', icon: IconSettings },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

function Sidebar({ collapsed, onToggle, mobile, onNavigate, can, attention }: { collapsed: boolean; onToggle: () => void; mobile?: boolean; onNavigate?: () => void; can: (c: string) => boolean; attention: number }) {
  const pathname = usePathname();
  const narrow = collapsed && !mobile;
  return (
    <nav aria-label="Primary" className={cx('flex h-full flex-col border-r border-rail-line bg-rail', narrow ? 'w-[60px]' : 'w-[244px]')}>
      <div className={cx('flex h-14 shrink-0 items-center', narrow ? 'justify-center' : 'gap-2.5 px-4')}>
        <img src="/brand/obiba-mark.png" alt="Obiba" width={24} height={24} className="size-6 shrink-0" />
        {!narrow && (
          <div className="min-w-0 leading-tight">
            <div className="text-sm font-semibold text-ink">Obiba</div>
            <div className="text-2xs text-muted">Operations</div>
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 pt-1 pb-4 scrollbar-thin">
        {NAV.map((g, gi) => {
          const items = g.items.filter((i) => !i.cap || can(i.cap));
          if (!items.length) return null;
          return (
            <div key={gi} className={cx(gi > 0 && 'mt-5')}>
              {g.group && !narrow && <div className="mb-1 px-2.5 text-2xs font-semibold tracking-[0.06em] text-brand-ink/70 uppercase">{g.group}</div>}
              {g.group && narrow && <div className="mx-auto mb-2 h-px w-6 bg-rail-line" />}
              <ul className="space-y-px">
                {items.map((i) => {
                  const on = isActive(pathname, i.href);
                  const Icon = i.icon;
                  return (
                    <li key={i.href}>
                      <Link
                        href={i.href}
                        onClick={onNavigate}
                        aria-current={on ? 'page' : undefined}
                        title={narrow ? i.label : undefined}
                        className={cx(
                          'group flex h-8 items-center rounded-md text-sm transition-colors',
                          narrow ? 'justify-center' : 'gap-2.5 px-2.5',
                          on ? 'bg-surface font-semibold text-ink shadow-[0_0_0_1px_var(--color-rail-line),0_1px_2px_rgb(11_11_12/0.04)]' : 'text-ink-3 hover:bg-[#eaf0f8] hover:text-ink',
                        )}
                      >
                        <span className={cx('shrink-0', on ? 'text-brand-ink' : 'text-muted group-hover:text-ink-3')}>
                          <Icon size={16} />
                        </span>
                        {!narrow && <span className="truncate">{i.label}</span>}
                        {!narrow && i.href === '/cases' && attention > 0 && <span className="tnum ml-auto text-xs font-medium text-critical">{attention}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      {!mobile && (
        <div className={cx('shrink-0 border-t border-rail-line p-2.5', narrow && 'flex justify-center')}>
          <button type="button" onClick={onToggle} className={cx('flex h-8 items-center gap-2.5 rounded-md text-sm text-muted hover:bg-[#eaf0f8] hover:text-ink', narrow ? 'w-8 justify-center' : 'w-full px-2.5')} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar  [' : 'Collapse sidebar  ['}>
            <IconSidebar size={16} />
            {!narrow && 'Collapse'}
          </button>
        </div>
      )}
    </nav>
  );
}

function worst(overview: Overview | null) {
  if (!overview) return null;
  return [...overview.signals].sort((a, b) => HEALTH[a.state].rank - HEALTH[b.state].rank)[0] ?? null;
}

function PlatformStatus({ overview, error }: { overview: Overview | null; error: boolean }) {
  const w = worst(overview);
  const problems = overview?.signals.filter((s) => s.state === 'CRITICAL' || s.state === 'STALE' || s.state === 'WARNING').length ?? 0;
  return (
    <Link href="/#health" className="hidden items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-wash lg:inline-flex" title="Worst current health signal">
      <span className="text-muted">Platform</span>
      {error ? <Status tone="muted">Unknown</Status> : !w ? <Spinner className="text-subtle" /> : problems === 0 ? <Status tone="positive">Healthy</Status> : <Status tone={HEALTH[w.state].tone}>{HEALTH[w.state].label}{problems > 1 ? ` · ${problems} signals` : ''}</Status>}
    </Link>
  );
}

function Notifications({ overview }: { overview: Overview | null }) {
  const items = overview?.attention ?? [];
  const count = items.length;
  return (
    <Popover
      label="Notifications"
      width={380}
      trigger={({ toggle, open, id }) => (
        <button type="button" onClick={toggle} aria-expanded={open} aria-controls={id} className="relative inline-flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-wash hover:text-ink" aria-label={`Notifications${count ? `, ${count} need attention` : ''}`}>
          <IconBell size={17} />
          {count > 0 && <span className="tnum absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-[5px] bg-action px-1 text-[10px] font-semibold text-white">{count}</span>}
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
            <div className="text-sm font-semibold text-ink">Requires attention</div>
            <span className="text-xs text-muted">From live signals</span>
          </div>
          {items.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted">Nothing requires attention right now.</div>
          ) : (
            <ul className="max-h-96 divide-y divide-hairline overflow-y-auto">
              {items.map((a) => (
                <li key={a.key}>
                  <Link href={a.href} onClick={close} className="block px-4 py-3 hover:bg-hover">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium text-ink">{a.title}</span>
                      <Status tone={SEVERITY[a.severity]!.tone} className="text-xs">
                        {SEVERITY[a.severity]!.label}
                      </Status>
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {a.detail}
                      {a.since && ` · for ${age(a.since)}`}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-hairline px-4 py-2.5 text-xs text-muted">External alert delivery is not configured. Do not rely on this console for paging.</div>
        </div>
      )}
    </Popover>
  );
}

function Identity({ session, devMode }: { session: Session; devMode: boolean }) {
  return (
    <Popover
      label="Staff identity"
      width={300}
      trigger={({ toggle, open, id }) => (
        <button type="button" onClick={toggle} aria-expanded={open} aria-controls={id} className="flex h-8 items-center gap-2 rounded-md pr-1.5 pl-1 hover:bg-wash">
          <span className="inline-flex size-6 items-center justify-center rounded-md bg-ink text-[11px] font-semibold text-white uppercase">{session.email.slice(0, 1)}</span>
          <span className="hidden max-w-40 truncate text-sm text-ink-2 md:inline">{session.email}</span>
          <IconChevronDown size={12} className="text-muted" />
        </button>
      )}
    >
      {(close) => (
        <div className="py-1.5">
          <div className="border-b border-hairline px-4 pt-2 pb-3">
            <div className="truncate text-sm font-semibold text-ink">{session.email}</div>
            <div className="mt-0.5 text-xs text-muted capitalize">{session.role} · {session.capabilities.length} capabilities</div>
            <div className="mt-1 text-xs text-muted">Signed in through {devMode ? 'local staff sign-in' : 'Identity-Aware Proxy'}</div>
          </div>
          <Link href="/staff" onClick={close} className="block px-4 py-2 text-sm text-ink-2 hover:bg-hover">
            Staff & access
          </Link>
          {devMode ? (
            <button type="button" onClick={() => setDevStaff(null)} className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-ink-2 hover:bg-hover">
              <IconLogout size={14} /> Switch staff member
            </button>
          ) : (
            <a href="/_gcp_iap/clear_login_cookie" className="flex items-center gap-2 px-4 py-2 text-sm text-ink-2 hover:bg-hover">
              <IconLogout size={14} /> Sign out
            </a>
          )}
        </div>
      )}
    </Popover>
  );
}

function CommandPalette({ onClose, can }: { onClose: () => void; can: (c: string) => boolean }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [found, setResults] = useState<{ tx: TxRow[]; customers: CustomerRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const ac = new AbortController();
    const t = window.setTimeout(() => {
      setBusy(true);
      Promise.all([api<Page<TxRow>>(`/v1/ops/transactions${qs({ q: term, limit: 6 })}`, { signal: ac.signal }), api<Page<CustomerRow>>(`/v1/ops/customers${qs({ q: term, limit: 5 })}`, { signal: ac.signal })])
        .then(([tx, c]) => setResults({ tx: tx.rows, customers: c.rows }))
        .catch(() => setResults({ tx: [], customers: [] }))
        .finally(() => !ac.signal.aborted && setBusy(false));
    }, 220);
    return () => {
      ac.abort();
      window.clearTimeout(t);
    };
  }, [q]);

  const pages = NAV.flatMap((g) => g.items.filter((i) => !i.cap || can(i.cap)));
  const term = q.trim().toLowerCase();
  const results = term.length >= 2 ? found : null;
  const navMatches = term ? pages.filter((p) => p.label.toLowerCase().includes(term)) : pages;
  const entries = [
    ...navMatches.map((p) => ({ key: `nav:${p.href}`, href: p.href, title: p.label, meta: 'Go to page', group: 'Pages' })),
    ...(results?.customers ?? []).map((c) => ({ key: `c:${c.uid}`, href: `/customers/${c.uid}`, title: c.name, meta: `${c.handle ? `@${c.handle} · ` : ''}${c.accountId ?? 'No account'}`, group: 'Customers' })),
    ...(results?.tx ?? []).map((t) => ({ key: `t:${t.type}:${t.id}`, href: `/transactions/${t.type}/${encodeURIComponent(t.id)}`, title: `${TX_TYPE_LABEL[t.type]} · ${formatAmount(t.amount, t.currency)} ${assetLabel(t.currency)}`, meta: `${PHASE[t.phase].label} · ${t.customer ?? 'Unknown customer'} · ${shortId(t.id)}`, group: 'Transactions' })),
  ];

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[rgb(11_11_12/0.32)] px-4 pt-[10vh] animate-fade" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Search" className="w-full max-w-[640px] overflow-hidden rounded-lg bg-surface shadow-pop animate-pop">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <IconSearch size={16} className="text-muted" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(entries.length - 1, i + 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              }
              if (e.key === 'Enter' && entries[index]) go(entries[index].href);
            }}
            placeholder="Search operation ID, customer, @handle, account, address or transaction hash"
            className="h-12 flex-1 bg-transparent text-md text-ink placeholder:text-subtle focus:outline-none"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={entries[index] ? `cmdk-${index}` : undefined}
          />
          {busy && <Spinner className="text-subtle" />}
          <kbd className="rounded border border-line px-1.5 text-2xs text-muted">Esc</kbd>
        </div>
        <ul id="cmdk-list" role="listbox" className="max-h-[52vh] overflow-y-auto py-1.5 scrollbar-thin">
          {entries.map((e, i) => {
            const header = e.group !== lastGroup ? e.group : null;
            lastGroup = e.group;
            return (
              <li key={e.key} role="presentation">
                {header && <div className="px-4 pt-2.5 pb-1 text-2xs font-semibold tracking-[0.06em] text-muted uppercase">{header}</div>}
                <button id={`cmdk-${i}`} role="option" aria-selected={i === index} type="button" onMouseEnter={() => setIndex(i)} onClick={() => go(e.href)} className={cx('flex w-full items-center justify-between gap-4 px-4 py-2 text-left', i === index && 'bg-brand-faint')}>
                  <span className="truncate text-sm font-medium text-ink">{e.title}</span>
                  <span className="truncate text-xs text-muted">{e.meta}</span>
                </button>
              </li>
            );
          })}
          {term.length >= 2 && results && results.tx.length === 0 && results.customers.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">No customers or transactions match “{q.trim()}”.</li>}
        </ul>
        <div className="flex items-center justify-between border-t border-hairline bg-raised px-4 py-2 text-xs text-muted">
          <span>Search is scoped to your role. Contact search needs the operator role.</span>
          <span>↑↓ to move · Enter to open</span>
        </div>
      </div>
    </div>
  );
}

function DevSignIn({ staff }: { staff: string[] }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 shadow-control">
        <img src="/brand/obiba-mark.png" alt="Obiba" width={28} height={28} />
        <h1 className="mt-4 text-xl font-semibold tracking-[-0.015em]">Obiba Operations</h1>
        <p className="mt-1 text-sm text-muted">Local staff sign-in. This chooser exists only when the operations service runs with local development login; production staff sign in through Identity-Aware Proxy.</p>
        <ul className="mt-5 divide-y divide-hairline rounded-md border border-line">
          {staff.map((s) => (
            <li key={s}>
              <button type="button" onClick={() => setDevStaff(s)} className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm text-ink-2 hover:bg-hover">
                {s}
                <span className="text-xs text-muted">Sign in</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Gate({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-6">
        <img src="/brand/obiba-mark.png" alt="Obiba" width={28} height={28} />
        <h1 className="mt-4 text-lg font-semibold">{title}</h1>
        <div className="mt-1 text-sm text-muted">{children}</div>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const staff = useDevStaff();
  const [devList, setDevList] = useState<string[] | null | undefined>(undefined);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return typeof window !== 'undefined' && window.localStorage.getItem('obiba-ops-sidebar') === 'collapsed';
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    fetch('/console/settings', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { devStaff: null }))
      .then((s: { devStaff: string[] | null }) => setDevList(s.devStaff && s.devStaff.length ? s.devStaff : null))
      .catch(() => setDevList(null));
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem('obiba-ops-sidebar', c ? 'expanded' : 'collapsed');
      } catch {
        return !c;
      }
      return !c;
    });
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (!typing && e.key === '/') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (!typing && e.key === '[') toggle();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [toggle]);

  const ready = devList !== undefined && (devList === null || !!staff);
  const sessionRes = useResource<Session>(ready ? '/v1/ops/session' : null);
  const overviewRes = useResource<Overview>(ready && sessionRes.data ? '/v1/ops/overview?window=24h' : null, { poll: 30_000 });
  const session = sessionRes.data;
  const can = useCallback((c: string) => !!session?.capabilities.includes(c), [session]);
  const ctx = useMemo<Ctx | null>(() => (session ? { session, overview: overviewRes.data, overviewAt: overviewRes.loadedAt, refreshOverview: overviewRes.refresh, can } : null), [session, overviewRes.data, overviewRes.loadedAt, overviewRes.refresh, can]);

  if (devList === undefined) return <div className="min-h-dvh bg-canvas" />;
  if (devList && !staff) return <DevSignIn staff={devList} />;
  if (sessionRes.error?.status === 403) return <Gate title="Access denied">Your account is not an active member of Obiba staff, or your access was suspended. Access is invitation-only; ask a security administrator.</Gate>;
  if (sessionRes.error) return <Gate title="Operations service unavailable">{sessionRes.error.message} Monitoring and alerting continue independently of this console.</Gate>;
  if (!ctx || !session) return <div className="min-h-dvh bg-canvas" aria-busy="true" />;

  const attentionCount = overviewRes.data?.attention.filter((a) => a.key === 'review' || a.key === 'unknown').reduce((s, a) => s + a.count, 0) ?? 0;

  return (
    <SessionCtx.Provider value={ctx}>
      <ToastProvider>
        <div className="flex min-h-dvh">
          <div className="sticky top-0 hidden h-dvh shrink-0 lg:block">
            <Sidebar collapsed={collapsed} onToggle={toggle} can={can} attention={attentionCount} />
          </div>
          {mobileOpen && (
            <div className="fixed inset-0 z-40 bg-[rgb(11_11_12/0.3)] lg:hidden animate-fade" onMouseDown={(e) => e.target === e.currentTarget && setMobileOpen(false)}>
              <div className="h-full w-[244px] animate-pop">
                <Sidebar collapsed={false} onToggle={toggle} mobile onNavigate={() => setMobileOpen(false)} can={can} attention={attentionCount} />
              </div>
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur-sm sm:px-5">
              <button type="button" onClick={() => setMobileOpen(true)} className="inline-flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-wash lg:hidden" aria-label="Open navigation">
                <IconMenu size={18} />
              </button>
              <Popover
                label="Business entity"
                align="start"
                width={280}
                trigger={({ toggle: t, open, id }) => (
                  <button type="button" onClick={t} aria-expanded={open} aria-controls={id} className="flex h-8 items-center gap-2 rounded-md px-2 hover:bg-wash">
                    <span className="text-sm font-semibold text-ink">{session.entity}</span>
                    {session.network && <span className={cx('text-xs font-medium', session.network === 'mainnet' ? 'text-muted' : 'text-caution')}>{session.network === 'mainnet' ? 'Mainnet' : 'Testnet'}</span>}
                    <IconChevronDown size={12} className="text-muted" />
                  </button>
                )}
              >
                {() => (
                  <div className="py-1.5">
                    <div className="px-4 pt-1 pb-2 text-xs text-muted">Entities you are authorized for</div>
                    <div className="flex items-center justify-between bg-brand-faint px-4 py-2 text-sm">
                      <span className="font-medium text-ink">{session.entity}</span>
                      <span className="text-xs text-muted">{session.network ? `NEAR ${session.network}` : 'Network not set'}</span>
                    </div>
                    <div className="px-4 pt-2 pb-1 text-xs text-muted">Additional entities appear here once your access includes them.</div>
                  </div>
                )}
              </Popover>
              <button type="button" onClick={() => setPaletteOpen(true)} className="ml-1 hidden h-8 w-full max-w-[420px] items-center gap-2 rounded-md border border-line bg-raised px-2.5 text-sm text-subtle hover:border-field hover:bg-surface md:flex" aria-label="Search">
                <IconSearch size={14} />
                <span className="flex-1 truncate text-left">Search transactions, customers, hashes</span>
                <kbd className="rounded border border-line bg-surface px-1.5 text-2xs text-muted">⌘K</kbd>
              </button>
              <div className="ml-auto flex items-center gap-1">
                <button type="button" onClick={() => setPaletteOpen(true)} className="inline-flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-wash md:hidden" aria-label="Search">
                  <IconSearch size={17} />
                </button>
                <PlatformStatus overview={overviewRes.data} error={!!overviewRes.error && !overviewRes.data} />
                <span className="tnum hidden px-2 text-xs text-muted xl:inline" title="Health and notifications refresh every 30 seconds">
                  {overviewRes.data ? `Signals ${ago(overviewRes.data.observedAt)}` : ''}
                </span>
                <Notifications overview={overviewRes.data} />
                <div className="mx-1 h-5 w-px bg-line" />
                <Identity session={session} devMode={!!devList} />
              </div>
            </header>
            <main className="mx-auto w-full max-w-[1480px] flex-1 px-4 pt-6 pb-16 sm:px-6 lg:px-8">{children}</main>
          </div>
        </div>
        {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} can={can} />}
      </ToastProvider>
    </SessionCtx.Provider>
  );
}

export function Gated({ capability, children }: { capability: string; children: ReactNode }) {
  const { can } = useSession();
  if (!can(capability)) {
    return (
      <div className="rounded-lg border border-line bg-surface px-6 py-10 text-center">
        <div className="text-md font-semibold text-ink-2">Access restricted</div>
        <div className="mx-auto mt-1 max-w-md text-sm text-muted">This area needs the {capability} capability, which your role does not include. The server enforces this independently of the interface.</div>
      </div>
    );
  }
  return <>{children}</>;
}

export function RefreshButton({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  return (
    <Button size="sm" onClick={onClick} busy={busy}>
      Refresh
    </Button>
  );
}
