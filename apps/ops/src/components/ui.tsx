'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { forwardRef, useEffect, useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { assetLabel, formatAmount } from '@/lib/format';
import { HEALTH, type HealthState, type Tone } from '@/lib/labels';
import { ago, dateTime, dateTimeShort, utc } from '@/lib/time';
import { IconCheck, IconChevronRight, IconCopy, IconExternal, IconRefresh } from './icons';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-action text-white hover:bg-action-hover shadow-control disabled:bg-action/40',
  secondary: 'bg-surface text-ink-2 border border-line hover:bg-hover hover:border-field shadow-control disabled:text-faint',
  ghost: 'text-ink-3 hover:bg-wash hover:text-ink disabled:text-faint',
  danger: 'bg-surface text-critical border border-critical-line hover:bg-critical-soft disabled:opacity-50',
  'danger-solid': 'bg-critical text-white hover:bg-[#9c1d23] disabled:opacity-50',
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; busy?: boolean; icon?: ReactNode }>(function Button(
  { variant = 'secondary', size = 'md', busy, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors duration-100 select-none',
        size === 'sm' ? 'h-7 px-2.5 text-sm' : 'h-8 px-3 text-sm',
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {busy ? <Spinner /> : icon}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx('inline-block size-3.5 animate-spin rounded-full border-[1.5px] border-current border-r-transparent', className)} />;
}

export const TONE_TEXT: Record<Tone, string> = {
  positive: 'text-positive',
  caution: 'text-caution',
  critical: 'text-critical',
  info: 'text-brand-ink',
  neutral: 'text-ink-3',
  muted: 'text-subtle',
};

export function Status({ tone, children, className, strong = true }: { tone: Tone; children: ReactNode; className?: string; strong?: boolean }) {
  return <span className={cx('text-sm whitespace-nowrap', strong && 'font-medium', TONE_TEXT[tone], className)}>{children}</span>;
}

export function Health({ state, className }: { state: HealthState; className?: string }) {
  const h = HEALTH[state];
  return (
    <Status tone={h.tone} className={className}>
      {h.label}
    </Status>
  );
}

export function Amount({ value, currency, className, size = 'sm', showCurrency = true, signed = false, maxFraction }: { value: string | null | undefined; currency: string; className?: string; size?: 'sm' | 'base' | 'lg' | 'xl' | 'hero'; showCurrency?: boolean; signed?: boolean; maxFraction?: number }) {
  const formatted = formatAmount(value, currency, { maxFraction });
  const sign = signed && value && !value.startsWith('-') && value !== '0' ? '+' : '';
  const sizes = { sm: 'text-sm', base: 'text-base', lg: 'text-lg font-medium', xl: 'text-xl font-semibold tracking-tight', hero: 'text-3xl font-semibold tracking-[-0.025em]' };
  return (
    <span className={cx('whitespace-nowrap', size === 'hero' || size === 'xl' ? 'pnum' : 'tnum', sizes[size], className)}>
      {sign}
      {formatted}
      {showCurrency && <span className={cx('ml-1 font-normal text-muted', size === 'hero' ? 'text-lg' : size === 'xl' ? 'text-md' : 'text-xs')}>{assetLabel(currency)}</span>}
    </span>
  );
}

export function Copyable({ value, display, className, mono = true }: { value: string; display?: ReactNode; className?: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <span className={cx('group/copy inline-flex max-w-full min-w-0 items-center gap-1', className)}>
      <span className={cx('truncate', mono && 'font-mono text-[12.5px] text-ink-2')} title={value}>
        {display ?? value}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          void navigator.clipboard?.writeText(value).then(() => setCopied(true));
        }}
        className={cx('inline-flex size-5 shrink-0 items-center justify-center rounded text-subtle transition-opacity hover:bg-wash hover:text-ink', copied ? 'opacity-100' : 'opacity-0 group-hover/copy:opacity-100 focus-visible:opacity-100')}
        aria-label={copied ? 'Copied' : 'Copy to clipboard'}
        title={copied ? 'Copied' : 'Copy'}
      >
        {copied ? <IconCheck size={12} className="text-positive" /> : <IconCopy size={12} />}
      </button>
    </span>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cx('inline-flex items-center gap-1 text-brand-ink hover:text-action hover:underline', className)}>
      {children}
      <IconExternal size={12} />
    </a>
  );
}

export function Time({ iso, className, relative = false, short = false }: { iso: string | null | undefined; className?: string; relative?: boolean; short?: boolean }) {
  if (!iso) return <span className={cx('text-subtle', className)}>—</span>;
  return (
    <time dateTime={iso} title={`${dateTime(iso)}\n${utc(iso)}`} className={cx('tnum whitespace-nowrap', className)}>
      {relative ? ago(iso) : short ? dateTimeShort(iso) : dateTime(iso)}
    </time>
  );
}

export function Crumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1 text-sm text-muted">
      {items.map((c, i) => (
        <span key={`${c.label}-${i}`} className="inline-flex min-w-0 items-center gap-1">
          {i > 0 && <IconChevronRight size={12} className="text-faint" />}
          {c.href ? (
            <Link href={c.href} className="hover:text-ink">
              {c.label}
            </Link>
          ) : (
            <span className="truncate text-ink-3" aria-current="page">
              {c.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function Freshness({ observedAt, refreshing, onRefresh, label = 'Observed' }: { observedAt: string | null | undefined; refreshing?: boolean; onRefresh?: () => void; label?: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 15_000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="flex items-center gap-2 text-sm text-muted">
      {observedAt && (
        <span title={`${dateTime(observedAt)}\n${utc(observedAt)}`} className="tnum hidden sm:inline">
          {label} {ago(observedAt)}
        </span>
      )}
      {onRefresh && (
        <Button size="sm" variant="secondary" onClick={onRefresh} busy={refreshing} icon={<IconRefresh size={14} />} aria-label="Refresh">
          Refresh
        </Button>
      )}
    </div>
  );
}

export function PageHeader({ title, description, crumbs, actions, meta }: { title: ReactNode; description?: ReactNode; crumbs?: { label: string; href?: string }[]; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <header className="mb-6">
      {crumbs && <Crumbs items={crumbs} />}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-[420px]">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-base text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 pt-1">{actions}</div>}
      </div>
      {meta && <div className="mt-3">{meta}</div>}
    </header>
  );
}

export function Section({ title, description, actions, children, className, id, flush }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string; flush?: boolean }) {
  return (
    <section id={id} className={cx('mb-10', className)} aria-labelledby={title && id ? `${id}-h` : undefined}>
      {(title || actions) && (
        <div className={cx('flex flex-wrap items-end justify-between gap-3', flush ? 'mb-2' : 'mb-3')}>
          <div className="min-w-0">
            {title && (
              <h2 id={id ? `${id}-h` : undefined} className="text-md font-semibold text-ink">
                {title}
              </h2>
            )}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-lg border border-line bg-surface', className)}>{children}</div>;
}

export function KeyValues({ rows, className, cols = 1 }: { rows: { label: ReactNode; value: ReactNode; hint?: ReactNode }[]; className?: string; cols?: 1 | 2 }) {
  return (
    <dl className={cx('grid', cols === 2 ? 'grid-cols-1 md:grid-cols-2 md:gap-x-10' : 'grid-cols-1', className)}>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[minmax(120px,40%)_1fr] gap-4 border-b border-hairline py-2.5 last:border-b-0">
          <dt className="text-sm text-muted">{r.label}</dt>
          <dd className="min-w-0 text-sm break-words text-ink-2">
            {r.value ?? <span className="text-subtle">—</span>}
            {r.hint && <div className="mt-0.5 text-xs text-muted">{r.hint}</div>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const BANNER: Record<'critical' | 'caution' | 'info' | 'neutral', string> = {
  critical: 'bg-critical-soft border-critical-line text-[#7d1a1f]',
  caution: 'bg-caution-soft border-caution-line text-[#6b4508]',
  info: 'bg-brand-faint border-brand-border text-brand-ink',
  neutral: 'bg-wash border-line text-ink-3',
};

export function Banner({ tone, title, children, actions, className }: { tone: keyof typeof BANNER; title?: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div role={tone === 'critical' ? 'alert' : 'status'} className={cx('flex flex-wrap items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm', BANNER[tone], className)}>
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cx(!!title && 'mt-0.5', 'opacity-90')}>{children}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ title, children, action, className }: { title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      <div className="text-md font-medium text-ink-2">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function LoadError({ error, onRetry, className }: { error: { status: number; message: string }; onRetry?: () => void; className?: string }) {
  const denied = error.status === 403;
  return (
    <div className={cx('rounded-lg border px-5 py-4', denied ? 'border-line bg-surface' : 'border-critical-line bg-critical-soft', className)} role="alert">
      <div className={cx('text-sm font-semibold', denied ? 'text-ink-2' : 'text-[#7d1a1f]')}>{denied ? 'Access restricted' : error.status === 0 ? 'Service unreachable' : 'Could not load this data'}</div>
      <div className={cx('mt-0.5 text-sm', denied ? 'text-muted' : 'text-[#7d1a1f]/90')}>
        {error.message} {!denied && 'Nothing shown here should be read as zero or healthy.'}
      </div>
      {onRetry && !denied && (
        <Button size="sm" className="mt-3" onClick={onRetry} icon={<IconRefresh size={14} />}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded bg-wash', className)} />;
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="divide-y divide-hairline">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-6 px-4 py-3.5">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

export function Tabs({ tabs, param = 'tab', className }: { tabs: { key: string; label: string; count?: number | null }[]; param?: string; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const active = sp.get(param) ?? tabs[0]?.key;
  return (
    <div role="tablist" className={cx('mb-6 flex gap-0.5 overflow-x-auto border-b border-line pb-2 scrollbar-thin', className)}>
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={on}
            onClick={() => {
              const next = new URLSearchParams(sp.toString());
              if (t.key === tabs[0]?.key) next.delete(param);
              else next.set(param, t.key);
              const q = next.toString();
              router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
            }}
            className={cx(
              'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm whitespace-nowrap transition-colors',
              on ? 'bg-wash font-semibold text-ink' : 'text-muted hover:bg-hover hover:text-ink',
            )}
          >
            {t.label}
            {t.count !== undefined && t.count !== null && <span className={cx('tnum text-xs', on ? 'text-ink-3' : 'text-subtle')}>{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function useTab(tabs: string[], param = 'tab'): string {
  const sp = useSearchParams();
  const v = sp.get(param);
  return v && tabs.includes(v) ? v : tabs[0]!;
}

export function Field({ label, description, error, required, children, htmlFor }: { label: string; description?: ReactNode; error?: string | null; required?: boolean; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="flex items-baseline gap-1.5 text-sm font-medium text-ink-2">
        {label}
        {required ? <span className="text-xs font-normal text-muted">Required</span> : <span className="text-xs font-normal text-subtle">Optional</span>}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-critical" role="alert">
          {error}
        </p>
      ) : description ? (
        <p className="text-xs text-muted">{description}</p>
      ) : null}
    </div>
  );
}

const CONTROL = 'rounded-md border border-field bg-surface px-2.5 text-sm text-ink shadow-control placeholder:text-subtle hover:border-faint focus:border-brand focus:outline-none focus:ring-3 focus:ring-brand/15 disabled:bg-wash disabled:text-subtle';

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  const { invalid, className, ...rest } = props;
  return <input {...rest} aria-invalid={invalid || undefined} className={cx(CONTROL, 'h-8 w-full', invalid && 'border-critical focus:border-critical focus:ring-critical/15', className)} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  const { invalid, className, ...rest } = props;
  return <textarea {...rest} aria-invalid={invalid || undefined} className={cx(CONTROL, 'min-h-[84px] w-full resize-y py-2 leading-5', invalid && 'border-critical focus:border-critical focus:ring-critical/15', className)} />;
}

export function Select({ value, onChange, options, label, className, id }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; label: string; className?: string; id?: string }) {
  const auto = useId();
  return (
    <select id={id ?? auto} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={cx(CONTROL, 'h-8 appearance-none bg-[length:12px] bg-[right_8px_center] bg-no-repeat pr-7', className)} style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%236b6b73' stroke-width='1.5'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E\")" }}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Metric({ label, value, caption, href, tone, className }: { label: ReactNode; value: ReactNode; caption?: ReactNode; href?: string; tone?: Tone; className?: string }) {
  const body = (
    <>
      <div className="text-sm text-muted">{label}</div>
      <div className={cx('mt-1.5 text-xl font-semibold tracking-[-0.015em]', tone ? TONE_TEXT[tone] : 'text-ink')}>{value}</div>
      {caption && <div className="mt-1 text-xs text-muted">{caption}</div>}
    </>
  );
  return href ? (
    <Link href={href} className={cx('group block px-5 py-4 transition-colors hover:bg-hover', className)}>
      {body}
    </Link>
  ) : (
    <div className={cx('px-5 py-4', className)}>{body}</div>
  );
}

export function NotConfigured({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-field bg-surface px-5 py-4">
      <div className="flex items-baseline justify-between gap-4">
        <div className="text-sm font-semibold text-ink-2">{title}</div>
        <Status tone="muted">Not configured</Status>
      </div>
      <div className="mt-1 text-sm text-muted">{children}</div>
    </div>
  );
}
