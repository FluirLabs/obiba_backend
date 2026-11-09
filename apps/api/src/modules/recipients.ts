import type { PoolClient } from 'pg';
import { isNearAccountId } from '@obiba/domain';
import type { AppConfig } from '../config';
import { appError } from '../errors';
import type { Recipient } from '../graphql/types';
import type { NearChain } from '../infra/near-chain';
import { ghanaPhone } from './validation';

const HANDLE = /^@?([a-z0-9_]{3,24})$/;
const PHONE = /^(\+?233|0)[\d\s-]{9,12}$/;
const IMPLICIT = /^[0-9a-f]{64}$/;

export type RecipientQuery = { by: 'handle'; value: string } | { by: 'phone'; value: string } | { by: 'account'; value: string };

export function classifyRecipient(raw: string): RecipientQuery {
  const q = raw.trim();
  if (q.length === 0 || q.length > 64) throw appError('BAD_INPUT', 'query');
  if (PHONE.test(q)) return { by: 'phone', value: ghanaPhone(q) };
  const lower = q.toLowerCase();
  const handle = HANDLE.exec(lower);
  if (handle && (q.startsWith('@') || (!lower.includes('.') && !IMPLICIT.test(lower)))) return { by: 'handle', value: handle[1]! };
  if (isNearAccountId(lower)) return { by: 'account', value: lower };
  throw appError('BAD_INPUT', 'query');
}

export function nsToIso(ns: string | undefined | null): string | null {
  if (!ns || !/^\d{1,20}$/.test(ns) || ns === '0') return null;
  return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
}

export async function resolveRecipient(
  c: PoolClient,
  chain: NearChain,
  config: AppConfig,
  query: RecipientQuery,
): Promise<Recipient | null> {
  if (query.by === 'handle' || query.by === 'phone') {
    const fn = query.by === 'handle' ? 'ops.resolve_recipient' : 'ops.resolve_recipient_by_phone';
    const r = await c.query<{ display_name: string; account_id: string }>(`select display_name, account_id from ${fn}($1)`, [query.value]);
    const row = r.rows[0];
    if (!row?.account_id) return null;
    const h = await c.query<{ handle: string | null }>('select handle from ops.resolve_recipient_by_account($1)', [row.account_id]);
    return { kind: 'OBIBA', accountId: row.account_id, displayName: row.display_name, handle: h.rows[0]?.handle ?? null, canReceive: true };
  }
  const own = await c.query<{ display_name: string; account_id: string; handle: string | null; active: boolean }>(
    'select display_name, account_id, handle, active from ops.resolve_recipient_by_account($1)',
    [query.value],
  );
  const o = own.rows[0];
  if (o) return { kind: 'OBIBA', accountId: o.account_id, displayName: o.display_name, handle: o.handle, canReceive: o.active };
  if (query.value.endsWith(config.ACCOUNT_SUFFIX) || query.value === config.PAY_CONTRACT || query.value === config.USDC_CONTRACT) return null;
  let registered: boolean;
  try {
    registered = await chain.storageRegistered(config.USDC_CONTRACT, query.value);
  } catch {
    throw appError('SERVICE_PAUSED');
  }
  return { kind: 'NEAR', accountId: query.value, displayName: null, handle: null, canReceive: registered };
}
