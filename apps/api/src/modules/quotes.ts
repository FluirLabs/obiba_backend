import { Field, Int, ObjectType } from '@nestjs/graphql';

export const QUOTE_SOURCE = 'NEAR Intents 1Click';

@ObjectType()
export class QuoteFees {
  @Field() source!: string;
  @Field(() => String, { nullable: true }) amountInUsd!: string | null;
  @Field(() => String, { nullable: true }) amountOutUsd!: string | null;
  @Field(() => String, { nullable: true }) providerSpreadUsd!: string | null;
  @Field(() => Int) appFeeBps!: number;
}

@ObjectType()
export class QuoteView {
  @Field() asset!: string;
  @Field() amountIn!: string;
  @Field() minAmountIn!: string;
  @Field() amountOut!: string;
  @Field() minAmountOut!: string;
  @Field() totalDebit!: string;
  @Field() deadline!: string;
  @Field(() => Int, { nullable: true }) timeEstimateSeconds!: number | null;
  @Field(() => QuoteFees) fees!: QuoteFees;
}

const USD = /^\d{1,15}(\.\d{1,8})?$/;

function usdCents(v: unknown): bigint | null {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
  if (!USD.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return BigInt(w!) * 100_000_000n + BigInt(f.padEnd(8, '0'));
}

function fmt(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const w = a / 100_000_000n;
  const f = (a % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${w}${f ? `.${f}` : ''}`;
}

export function feesOf(quote: Record<string, unknown> | undefined, appFeeBps: number): QuoteFees {
  const inUsd = usdCents(quote?.amountInUsd);
  const outUsd = usdCents(quote?.amountOutUsd);
  return {
    source: QUOTE_SOURCE,
    amountInUsd: inUsd === null ? null : fmt(inUsd),
    amountOutUsd: outUsd === null ? null : fmt(outUsd),
    providerSpreadUsd: inUsd === null || outUsd === null ? null : fmt(inUsd - outUsd),
    appFeeBps,
  };
}

export function quoteView(asset: string, q: Record<string, unknown>, fallbackAmount: string, appFeeBps: number): QuoteView {
  const amountIn = String(q.amountIn ?? fallbackAmount);
  return {
    asset,
    amountIn,
    minAmountIn: String(q.minAmountIn ?? amountIn),
    amountOut: String(q.amountOut ?? ''),
    minAmountOut: String(q.minAmountOut ?? q.amountOut ?? ''),
    totalDebit: amountIn,
    deadline: String(q.deadline ?? ''),
    timeEstimateSeconds: typeof q.timeEstimate === 'number' ? q.timeEstimate : null,
    fees: feesOf(q, appFeeBps),
  };
}
