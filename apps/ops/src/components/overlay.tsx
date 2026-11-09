'use client';

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from './icons';
import { cx } from './ui';

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
}

function useFocusTrap(open: boolean, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () => Array.from(node?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])') ?? []);
    const first = node?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0];
    first?.focus();
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      const a = f[0]!;
      const b = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        b.focus();
      } else if (!e.shiftKey && document.activeElement === b) {
        e.preventDefault();
        a.focus();
      }
    };
    node?.addEventListener('keydown', h);
    return () => {
      node?.removeEventListener('keydown', h);
      previous?.focus?.();
    };
  }, [open, ref]);
}

const noop = () => () => undefined;

function Portal({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  return mounted ? createPortal(children, document.body) : null;
}

export function Dialog({ open, onClose, title, description, children, footer, width = 520, tone }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; width?: number; tone?: 'critical' }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEscape(open, onClose);
  useFocusTrap(open, ref);
  if (!open) return null;
  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgb(11_11_12/0.32)] px-4 pt-[12vh] pb-8 animate-fade" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} className="w-full rounded-lg bg-surface shadow-pop animate-pop" style={{ maxWidth: width }}>
          <div className="flex items-start justify-between gap-4 border-b border-hairline px-5 pt-4 pb-3.5">
            <div className="min-w-0">
              <h2 id={`${id}-t`} className={cx('text-md font-semibold', tone === 'critical' ? 'text-critical' : 'text-ink')}>
                {title}
              </h2>
              {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
            </div>
            <button type="button" onClick={onClose} className="-mr-1.5 inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-wash hover:text-ink" aria-label="Close">
              <IconClose size={14} />
            </button>
          </div>
          {children && <div className="px-5 py-4">{children}</div>}
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline bg-raised px-5 py-3 rounded-b-lg">{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}

export function Drawer({ open, onClose, title, subtitle, children, footer, width = 560 }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEscape(open, onClose);
  useFocusTrap(open, ref);
  if (!open) return null;
  return (
    <Portal>
      <div className="fixed inset-0 z-40 bg-[rgb(11_11_12/0.18)] animate-fade" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <aside ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} className="absolute inset-y-0 right-0 flex w-full flex-col bg-surface shadow-sheet animate-sheet" style={{ maxWidth: width }}>
          <div className="flex items-start justify-between gap-4 border-b border-line px-6 pt-5 pb-4">
            <div className="min-w-0">
              <h2 id={`${id}-t`} className="truncate text-lg font-semibold tracking-[-0.01em] text-ink">
                {title}
              </h2>
              {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
            </div>
            <button type="button" onClick={onClose} className="-mr-2 inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-wash hover:text-ink" aria-label="Close panel">
              <IconClose size={15} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-5 scrollbar-thin">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-raised px-6 py-3">{footer}</div>}
        </aside>
      </div>
    </Portal>
  );
}

export function Popover({ trigger, children, align = 'end', width = 280, label }: { trigger: (props: { open: boolean; toggle: () => void; id: string }) => ReactNode; children: (close: () => void) => ReactNode; align?: 'start' | 'end'; width?: number; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  useEscape(open, close);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o), id })}
      {open && (
        <div id={id} role="dialog" aria-label={label} className={cx('absolute top-full z-30 mt-1.5 rounded-lg border border-line bg-surface shadow-pop animate-pop', align === 'end' ? 'right-0' : 'left-0')} style={{ width }}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

type Toast = { id: number; tone: 'positive' | 'critical' | 'info'; title: string; body?: string };
const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all.slice(-3), { ...t, id }]);
    window.setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), t.tone === 'critical' ? 9000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto rounded-lg border border-line bg-surface px-4 py-3 shadow-pop animate-pop">
            <div className={cx('text-sm font-semibold', t.tone === 'critical' ? 'text-critical' : t.tone === 'positive' ? 'text-positive' : 'text-ink')}>{t.title}</div>
            {t.body && <div className="mt-0.5 text-sm text-muted">{t.body}</div>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
