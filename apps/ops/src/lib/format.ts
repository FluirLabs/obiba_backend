export interface AssetMeta {
  decimals: number;
  label: string;
}

export const ASSET_META: Record<string, AssetMeta> = {
  USDC: { decimals: 6, label: 'USDC' },
  DEMO_USDC: { decimals: 6, label: 'Pilot USDC' },
  NEAR: { decimals: 24, label: 'NEAR' },
};

export function assetLabel(currency: string): string {
  return ASSET_META[currency]?.label ?? currency;
}

function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatUnits(base: string | null | undefined, decimals: number, opts: { minFraction?: number; maxFraction?: number } = {}): string {
  if (base === null || base === undefined || base === '' || !/^-?\d+$/.test(base)) return '—';
  const minFraction = opts.minFraction ?? 2;
  const maxFraction = opts.maxFraction ?? decimals;
  let v = BigInt(base);
  const negative = v < 0n;
  if (negative) v = -v;
  const scale = 10n ** BigInt(decimals);
  let int = v / scale;
  let frac = (v % scale).toString().padStart(decimals, '0');
  if (maxFraction < decimals) {
    const keep = frac.slice(0, maxFraction);
    const rest = frac.slice(maxFraction);
    let rounded = BigInt(keep || '0');
    if (rest.length && Number(rest[0]) >= 5) rounded += 1n;
    if (maxFraction === 0) {
      if (rounded > 0n) int += 1n;
      frac = '';
    } else {
      const limit = 10n ** BigInt(maxFraction);
      if (rounded >= limit) {
        int += 1n;
        rounded -= limit;
      }
      frac = rounded.toString().padStart(maxFraction, '0');
    }
  }
  frac = frac.replace(/0+$/, '');
  if (frac.length < minFraction) frac = frac.padEnd(minFraction, '0');
  const out = frac ? `${group(int.toString())}.${frac}` : group(int.toString());
  return negative ? `−${out}` : out;
}

export function formatAmount(base: string | null | undefined, currency: string, opts: { minFraction?: number; maxFraction?: number } = {}): string {
  const meta = ASSET_META[currency];
  return formatUnits(base, meta?.decimals ?? 0, opts);
}

export function signedAmount(base: string, currency: string): string {
  const v = formatAmount(base, currency);
  return base.startsWith('-') ? v : `+${v}`;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits).replace(/\.0+$/, '')}%`;
}

export function shortId(id: string | null | undefined, head = 8, tail = 6): string {
  if (!id) return '—';
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function compareBase(a: string, b: string): number {
  const x = BigInt(a || '0');
  const y = BigInt(b || '0');
  return x === y ? 0 : x < y ? -1 : 1;
}
