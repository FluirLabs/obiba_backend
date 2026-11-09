'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconCheck, IconChevronDown, IconChevronUp, IconColumns } from './icons';
import { Popover } from './overlay';
import { Button, cx, Empty, LoadError, SkeletonRows } from './ui';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right';
  width?: string;
  sort?: (row: T) => string | number | bigint;
  hideable?: boolean;
  defaultHidden?: boolean;
  className?: string;
  label?: string;
}

function loadHidden(key: string | undefined, fallback: string[]): Set<string> {
  if (!key || typeof window === 'undefined') return new Set(fallback);
  try {
    const raw = window.localStorage.getItem(`obiba-ops-cols:${key}`);
    return new Set(raw ? (JSON.parse(raw) as string[]) : fallback);
  } catch {
    return new Set(fallback);
  }
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  onRowClick,
  loading,
  error,
  onRetry,
  empty,
  storageKey,
  toolbar,
  footer,
  caption,
  dense,
  stale,
  selectedKey,
  minWidth = 860,
}: {
  columns: Column<T>[];
  rows: T[] | null;
  rowKey: (row: T) => string;
  rowHref?: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  error?: { status: number; message: string } | null;
  onRetry?: () => void;
  empty?: ReactNode;
  storageKey?: string;
  toolbar?: ReactNode;
  footer?: ReactNode;
  caption?: string;
  dense?: boolean;
  stale?: boolean;
  selectedKey?: string | null;
  minWidth?: number;
}) {
  const router = useRouter();
  const defaults = useMemo(() => columns.filter((c) => c.defaultHidden).map((c) => c.key), [columns]);
  const [hidden, setHidden] = useState<Set<string>>(() => loadHidden(storageKey, defaults));
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [cursor, setCursor] = useState(-1);
  const body = useRef<HTMLTableSectionElement>(null);

  useEffect(() => {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(`obiba-ops-cols:${storageKey}`, JSON.stringify([...hidden]));
    } catch {
      return;
    }
  }, [hidden, storageKey]);

  const visible = columns.filter((c) => !hidden.has(c.key));
  const sorted = useMemo(() => {
    if (!rows || !sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const get = col.sort;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [rows, sort, columns]);

  const open = (row: T, newTab = false) => {
    if (rowHref) {
      if (newTab) window.open(rowHref(row), '_blank', 'noopener');
      else router.push(rowHref(row));
    } else onRowClick?.(row);
  };
  const interactive = !!(rowHref || onRowClick);

  const onKey = (e: React.KeyboardEvent) => {
    if (!sorted?.length || !interactive) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(0, Math.min(sorted.length - 1, cursor + (e.key === 'ArrowDown' ? 1 : -1)));
      setCursor(next);
      body.current?.querySelectorAll<HTMLTableRowElement>('tr[data-row]')[next]?.focus();
    }
  };

  const hideable = columns.filter((c) => c.hideable);

  return (
    <div className={cx('overflow-hidden rounded-lg border border-line bg-surface', stale && 'opacity-60 transition-opacity')}>
      {(toolbar || hideable.length > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{toolbar}</div>
          {hideable.length > 0 && (
            <Popover
              label="Columns"
              width={220}
              trigger={({ toggle, open: o, id }) => (
                <Button size="sm" variant="ghost" onClick={toggle} aria-expanded={o} aria-controls={id} icon={<IconColumns size={14} />}>
                  Columns
                </Button>
              )}
            >
              {() => (
                <div className="py-1.5">
                  <div className="px-3 pt-1 pb-1.5 text-xs text-muted">Show columns</div>
                  {hideable.map((c) => {
                    const on = !hidden.has(c.key);
                    return (
                      <button
                        key={c.key}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={on}
                        onClick={() =>
                          setHidden((h) => {
                            const n = new Set(h);
                            if (on) n.add(c.key);
                            else n.delete(c.key);
                            return n;
                          })
                        }
                        className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm text-ink-2 hover:bg-hover"
                      >
                        {c.label ?? c.header}
                        {on && <IconCheck size={14} className="text-brand-ink" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </Popover>
          )}
        </div>
      )}
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full border-collapse text-left" style={{ minWidth }}>
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr className="border-b border-line bg-raised">
              {visible.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th key={c.key} scope="col" style={{ width: c.width }} aria-sort={active ? (sort!.dir === 1 ? 'ascending' : 'descending') : undefined} className={cx('h-9 px-4 text-xs font-medium whitespace-nowrap text-muted', c.align === 'right' && 'text-right')}>
                    {c.sort ? (
                      <button
                        type="button"
                        onClick={() => setSort((s) => (s?.key === c.key ? (s.dir === -1 ? { key: c.key, dir: 1 } : null) : { key: c.key, dir: -1 }))}
                        className={cx('inline-flex items-center gap-1 hover:text-ink', active && 'text-ink', c.align === 'right' && 'flex-row-reverse')}
                        title="Sorts the rows loaded on this page"
                      >
                        {c.header}
                        {active ? sort!.dir === 1 ? <IconChevronUp size={11} /> : <IconChevronDown size={11} /> : <span className="w-[11px]" />}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody ref={body} onKeyDown={onKey}>
            {sorted?.map((row, i) => {
              const k = rowKey(row);
              return (
                <tr
                  key={k}
                  data-row
                  tabIndex={interactive ? 0 : undefined}
                  aria-selected={selectedKey === k || undefined}
                  onFocus={() => setCursor(i)}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('a,button')) return;
                    open(row, e.metaKey || e.ctrlKey);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.target === e.currentTarget) open(row, e.metaKey || e.ctrlKey);
                  }}
                  className={cx(
                    'border-b border-hairline last:border-b-0 focus:outline-none',
                    interactive && 'cursor-pointer hover:bg-hover focus-visible:bg-brand-faint focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-brand)]',
                    selectedKey === k && 'bg-brand-faint',
                  )}
                >
                  {visible.map((c) => (
                    <td key={c.key} className={cx('px-4 align-middle text-sm text-ink-2', dense ? 'py-2' : 'py-2.5', c.align === 'right' && 'text-right', c.className)}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {loading && !rows && <SkeletonRows />}
      {error && !rows && (
        <div className="p-4">
          <LoadError error={error} onRetry={onRetry} />
        </div>
      )}
      {error && rows && (
        <div className="border-t border-critical-line bg-critical-soft px-4 py-2 text-sm text-[#7d1a1f]" role="alert">
          Refresh failed: {error.message} Showing the last loaded results.
        </div>
      )}
      {rows && rows.length === 0 && (empty ?? <Empty title="No records match">Adjust the filters or search to widen the results.</Empty>)}
      {footer && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-raised px-4 py-2.5 text-sm text-muted">{footer}</div>}
    </div>
  );
}

export function useCursorPages() {
  const [pages, setPages] = useState<string[]>([]);
  const next = useCallback((c: string) => setPages((p) => [...p, c]), []);
  const prev = useCallback(() => setPages((p) => p.slice(0, -1)), []);
  const reset = useCallback(() => setPages((p) => (p.length ? [] : p)), []);
  return { cursor: pages[pages.length - 1] ?? null, page: pages.length + 1, next, prev, reset } as const;
}

export function Pager({ page, count, hasNext, hasPrev, onNext, onPrev, noun = 'records' }: { page: number; count: number; hasNext: boolean; hasPrev: boolean; onNext: () => void; onPrev: () => void; noun?: string }) {
  return (
    <>
      <span className="tnum">
        Page {page} · {count} {noun}
      </span>
      <div className="flex items-center gap-1.5">
        <Button size="sm" onClick={onPrev} disabled={!hasPrev}>
          Previous
        </Button>
        <Button size="sm" onClick={onNext} disabled={!hasNext}>
          Next
        </Button>
      </div>
    </>
  );
}
