import type { PoolClient } from 'pg';
import { SANDBOX_CURRENCY, SANDBOX_KINDS, SANDBOX_NOTICE, localRailProvider, type RailIntent, type SandboxKind } from '@obiba/domain';

export interface SettledSandboxOp {
  id: string;
  uid: string;
  status: 'SUCCEEDED' | 'FAILED' | 'REVIEW';
}

interface Row {
  id: string;
  uid: string;
  kind: SandboxKind;
  provider: string;
  target: string;
  quote: { amount_units: string; fee_units: string; total_units: string; rate?: string };
  receipt: { ref: string; provider_ref?: string };
}

function intentOf(op: Row): RailIntent {
  return { id: op.id, kind: op.kind, provider: op.provider, target: op.target, amountUnits: BigInt(op.quote.amount_units), providerRef: op.receipt.provider_ref ?? null };
}

async function demoAccount(c: PoolClient, kind: string, ref: string): Promise<string> {
  const r = await c.query<{ id: string }>("select ledger.ensure_account('DEMO', $1, $2, $3) as id", [kind, ref, SANDBOX_CURRENCY]);
  return r.rows[0]!.id;
}

export async function settleSandboxOp(c: PoolClient, id: string, settleAfterSeconds: number, tokenDigits: () => string): Promise<SettledSandboxOp | null> {
  const r = await c.query<Row>(
    `select id, uid, kind, provider, target, quote, receipt from ops.sandbox_ops
      where id = $1 and status = 'PENDING' and funding = 'DEMO' and created_at <= now() - make_interval(secs => $2) for update`,
    [id, settleAfterSeconds],
  );
  const op = r.rows[0];
  if (!op) return null;
  const rail = localRailProvider(op.kind, op.provider, op.quote.rate ?? '1');
  const intent = intentOf(op);
  const evidence = rail.inquire(intent, tokenDigits);
  if (evidence.status === 'PENDING') return null;
  if (!rail.verifyEvidence(intent, evidence)) return apply(c, op, 'REVIEW', () => '', null);
  return apply(c, op, evidence.status, tokenDigits, evidence.token);
}

export async function resolveSandboxReview(c: PoolClient, id: string, outcome: 'SUCCEEDED' | 'FAILED', tokenDigits: () => string): Promise<SettledSandboxOp | null> {
  const r = await c.query<Row>("select id, uid, kind, provider, target, quote, receipt from ops.sandbox_ops where id = $1 and status = 'REVIEW' and funding = 'DEMO' for update", [id]);
  const op = r.rows[0];
  if (!op) return null;
  return apply(c, op, outcome, tokenDigits, null);
}

async function apply(c: PoolClient, op: Row, outcome: SettledSandboxOp['status'], tokenDigits: () => string, railToken: string | null): Promise<SettledSandboxOp> {
  const spec = SANDBOX_KINDS[op.kind];
  const holdRef = `sandbox:${op.id}`;
  let token: string | null = railToken;
  if (outcome === 'SUCCEEDED') {
    const user = await demoAccount(c, 'DEMO_USER', `demo:${op.uid}`);
    const amount = BigInt(op.quote.amount_units);
    const fee = BigInt(op.quote.fee_units);
    if (spec.direction === 'CREDIT') {
      const faucet = await demoAccount(c, 'DEMO_FAUCET', 'demo:faucet');
      await c.query('select ledger.post_demo_journal($1, $2, $3::jsonb, $4::jsonb)', [
        `sandbox:${op.receipt.ref}`,
        `sandbox_${op.kind.toLowerCase()}`,
        JSON.stringify([
          { account_id: user, amount: amount.toString(), currency: SANDBOX_CURRENCY },
          { account_id: faucet, amount: (-amount).toString(), currency: SANDBOX_CURRENCY },
        ]),
        JSON.stringify({ kind: op.kind, sandbox: true }),
      ]);
    } else {
      await c.query("select ledger.close_hold($1, 'CAPTURED')", [holdRef]);
      const provider = await demoAccount(c, 'DEMO_PROVIDER', `demo:provider:${op.kind.toLowerCase()}`);
      const entries = [
        { account_id: user, amount: (-(amount + fee)).toString(), currency: SANDBOX_CURRENCY },
        { account_id: provider, amount: amount.toString(), currency: SANDBOX_CURRENCY },
      ];
      if (fee > 0n) entries.push({ account_id: await demoAccount(c, 'DEMO_PROVIDER', 'demo:provider:fees'), amount: fee.toString(), currency: SANDBOX_CURRENCY });
      await c.query('select ledger.post_demo_journal($1, $2, $3::jsonb, $4::jsonb)', [
        `sandbox:${op.receipt.ref}`,
        `sandbox_${op.kind.toLowerCase()}`,
        JSON.stringify(entries),
        JSON.stringify({ kind: op.kind, sandbox: true }),
      ]);
      if (op.kind === 'ECG' && !token) token = `PILOT-${tokenDigits().slice(0, 20).match(/.{4}/g)!.join('-')}`;
    }
  } else if (outcome === 'FAILED' && spec.direction === 'DEBIT') {
    localRailProvider(op.kind, op.provider, op.quote.rate ?? '1').refund(intentOf(op));
    await c.query("select ledger.close_hold($1, 'RELEASED')", [holdRef]);
  }
  await c.query("update ops.sandbox_ops set status = $2, receipt = receipt || $3::jsonb, updated_at = now() where id = $1", [
    op.id,
    outcome,
    JSON.stringify({ notice: SANDBOX_NOTICE, sandbox: true, token }),
  ]);
  return { id: op.id, uid: op.uid, status: outcome };
}

export async function mirrorRealCredits(c: PoolClient, uid: string): Promise<number> {
  const credits: Array<{ id: string; amount: string }> = [];
  const mirrored = new Set<string>();
  let before: string | null = null;
  for (let page = 0; page < 20; page++) {
    const r: { rows: Array<{ journal_id: string; domain: string; kind: string; op_ref: string; amount: string }> } = await c.query(
      'select journal_id::text, domain::text, kind, op_ref, amount from ledger.my_activity_detail(100, $1)',
      [before],
    );
    for (const row of r.rows) {
      if (row.domain === 'REAL' && !row.amount.startsWith('-') && /^[1-9]\d*$/.test(row.amount)) credits.push({ id: row.journal_id, amount: row.amount });
      if (row.domain === 'DEMO' && row.kind === 'sandbox_mirror') mirrored.add(row.op_ref);
    }
    if (r.rows.length < 100) break;
    before = r.rows[r.rows.length - 1]!.journal_id;
  }
  let posted = 0;
  for (const credit of credits) {
    const opRef = `sandbox_mirror:${credit.id}`;
    if (mirrored.has(opRef)) continue;
    await c.query('savepoint sandbox_mirror');
    try {
      const user = await demoAccount(c, 'DEMO_USER', `demo:${uid}`);
      const faucet = await demoAccount(c, 'DEMO_FAUCET', 'demo:faucet');
      await c.query('select ledger.post_demo_journal($1, $2, $3::jsonb, $4::jsonb)', [
        opRef,
        'sandbox_mirror',
        JSON.stringify([
          { account_id: user, amount: credit.amount, currency: SANDBOX_CURRENCY },
          { account_id: faucet, amount: `-${credit.amount}`, currency: SANDBOX_CURRENCY },
        ]),
        JSON.stringify({ kind: 'MIRROR', sandbox: true, real_journal: credit.id }),
      ]);
      await c.query('release savepoint sandbox_mirror');
      posted++;
    } catch (err) {
      await c.query('rollback to savepoint sandbox_mirror');
      if ((err as { code?: string }).code !== '23505') throw err;
    }
  }
  return posted;
}
