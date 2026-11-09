'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef } from 'react';

export function useFilters<K extends string>(keys: readonly K[], storageKey: string): [Record<K, string>, (patch: Partial<Record<K, string>>) => void, () => void] {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const restored = useRef(false);

  const values = useMemo(() => Object.fromEntries(keys.map((k) => [k, sp.get(k) ?? ''])) as Record<K, string>, [sp, keys]);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (keys.some((k) => sp.get(k))) return;
    try {
      const saved = window.sessionStorage.getItem(`obiba-ops-filters:${storageKey}`);
      if (saved) {
        const next = new URLSearchParams(sp.toString());
        const parsed = JSON.parse(saved) as Record<string, string>;
        let changed = false;
        for (const k of keys) {
          if (parsed[k]) {
            next.set(k, parsed[k]);
            changed = true;
          }
        }
        if (changed) router.replace(`${pathname}?${next.toString()}`, { scroll: false });
      }
    } catch {
      return;
    }
  }, [keys, pathname, router, sp, storageKey]);

  const set = useCallback(
    (patch: Partial<Record<K, string>>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch) as [K, string | undefined][]) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      try {
        window.sessionStorage.setItem(`obiba-ops-filters:${storageKey}`, JSON.stringify(Object.fromEntries(keys.map((k) => [k, next.get(k) ?? '']))));
      } catch {
        return;
      } finally {
        const q = next.toString();
        router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
      }
    },
    [keys, pathname, router, sp, storageKey],
  );

  const reset = useCallback(() => set(Object.fromEntries(keys.map((k) => [k, ''])) as Partial<Record<K, string>>), [keys, set]);
  return [values, set, reset];
}

export const RANGES = [
  { value: '', label: 'All time' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
];

export function rangeFrom(range: string, now = Date.now()): string | null {
  const ms: Record<string, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '90d': 90 * 86_400_000 };
  const d = ms[range];
  return d ? new Date(Math.floor((now - d) / 60_000) * 60_000).toISOString() : null;
}
