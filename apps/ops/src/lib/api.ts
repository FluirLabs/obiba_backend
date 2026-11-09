'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const STAFF_KEY = 'obiba-ops-staff';
const listeners = new Set<() => void>();
let devStaff: string | null = null;

function readStaff(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(STAFF_KEY);
  } catch {
    return null;
  }
}

export function getDevStaff(): string | null {
  return devStaff ?? readStaff();
}

export function setDevStaff(email: string | null): void {
  devStaff = email;
  try {
    if (email) window.sessionStorage.setItem(STAFF_KEY, email);
    else window.sessionStorage.removeItem(STAFF_KEY);
  } catch {
    return;
  } finally {
    listeners.forEach((l) => l());
  }
}

export function useDevStaff(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getDevStaff,
    () => null,
  );
}

let generation = 0;
export function invalidateAll(): void {
  generation += 1;
  listeners.forEach((l) => l());
}

function headers(json: boolean): HeadersInit {
  const h: Record<string, string> = { accept: 'application/json' };
  if (json) h['content-type'] = 'application/json';
  const staff = getDevStaff();
  if (staff) h['x-goog-iap-jwt-assertion'] = `dev:${staff}`;
  return h;
}

function message(status: number, body: unknown): string {
  const m = body && typeof body === 'object' && 'message' in body ? (body as { message: unknown }).message : null;
  if (typeof m === 'string' && m && m !== 'Internal server error') return m.charAt(0).toUpperCase() + m.slice(1);
  if (status === 403) return 'Your role does not include access to this.';
  if (status === 404) return 'This record does not exist or is outside your scope.';
  if (status === 409) return 'The record changed since you loaded it. Reload and review it again.';
  if (status >= 500) return 'The operations service could not complete the request.';
  return `Request failed (${status}).`;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      headers: headers(init.body !== undefined),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: init.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'The operations service is unreachable. Data shown may be out of date.');
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new ApiError(res.status, message(res.status, body));
  return body as T;
}

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  refreshing: boolean;
  loadedAt: number | null;
  refresh: () => void;
}

export function useResource<T>(path: string | null, opts: { poll?: number } = {}): Resource<T> {
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loadedAt: number | null; done: string | null }>({ data: null, error: null, loadedAt: null, done: null });
  const [tick, setTick] = useState(0);
  const staff = useDevStaff();
  const gen = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => generation,
    () => 0,
  );
  const controller = useRef<AbortController | null>(null);
  const request = path ? `${path}#${tick}#${staff ?? ''}#${gen}` : null;

  useEffect(() => {
    if (!path || !request) return;
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    api<T>(path, { signal: ac.signal }).then(
      (data) => {
        if (!ac.signal.aborted) setState({ data, error: null, loadedAt: Date.now(), done: request });
      },
      (err: unknown) => {
        if (ac.signal.aborted) return;
        setState((s) => ({ ...s, error: err instanceof ApiError ? err : new ApiError(0, 'Unexpected error'), done: request }));
      },
    );
    return () => ac.abort();
  }, [path, request]);

  useEffect(() => {
    if (!opts.poll || !path) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, opts.poll);
    return () => window.clearInterval(id);
  }, [opts.poll, path]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const pending = !!request && state.done !== request;
  return {
    data: state.data,
    error: state.error,
    loading: pending && state.data === null,
    refreshing: pending && state.data !== null,
    loadedAt: state.loadedAt,
    refresh,
  };
}

export function qs(params: Record<string, string | number | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}
