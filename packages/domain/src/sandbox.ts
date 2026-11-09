export const SANDBOX_NOTICE = 'Local payment services are in pilot and not yet connected to providers.';
export const SANDBOX_CURRENCY = 'DEMO_USDC';
export const SANDBOX_DECIMALS = 6;
export const SANDBOX_MAX_GHS_PESEWAS = 1_500_000n;

export type SandboxKind = 'MOMO_FUND' | 'BANK_FUND' | 'AIRTIME' | 'DATA' | 'ECG' | 'WATER' | 'TV' | 'MOMO_PAYOUT' | 'BANK_PAYOUT';
export type SandboxDirection = 'CREDIT' | 'DEBIT';
export type SandboxOutcome = 'SUCCEEDED' | 'FAILED' | 'REVIEW';

export interface SandboxProduct {
  id: string;
  provider: string;
  label: string;
  priceGhsPesewas: bigint;
}

export interface SandboxKindSpec {
  kind: SandboxKind;
  label: string;
  direction: SandboxDirection;
  providers: string[];
  target: 'phone' | 'bank_account' | 'meter' | 'water_account' | 'smartcard';
  feeBps: number;
  minFeePesewas: bigint;
  usesProducts: boolean;
}

export const SANDBOX_KINDS: Record<SandboxKind, SandboxKindSpec> = {
  MOMO_FUND: { kind: 'MOMO_FUND', label: 'Mobile money deposit', direction: 'CREDIT', providers: ['MTN', 'TELECEL', 'AT'], target: 'phone', feeBps: 0, minFeePesewas: 0n, usesProducts: false },
  BANK_FUND: { kind: 'BANK_FUND', label: 'Bank deposit', direction: 'CREDIT', providers: ['GCB', 'ECOBANK', 'STANBIC', 'ABSA', 'FIDELITY'], target: 'bank_account', feeBps: 0, minFeePesewas: 0n, usesProducts: false },
  MOMO_PAYOUT: { kind: 'MOMO_PAYOUT', label: 'Send to mobile money', direction: 'DEBIT', providers: ['MTN', 'TELECEL', 'AT'], target: 'phone', feeBps: 100, minFeePesewas: 100n, usesProducts: false },
  BANK_PAYOUT: { kind: 'BANK_PAYOUT', label: 'Send to bank account', direction: 'DEBIT', providers: ['GCB', 'ECOBANK', 'STANBIC', 'ABSA', 'FIDELITY'], target: 'bank_account', feeBps: 100, minFeePesewas: 200n, usesProducts: false },
  AIRTIME: { kind: 'AIRTIME', label: 'Airtime', direction: 'DEBIT', providers: ['MTN', 'TELECEL', 'AT'], target: 'phone', feeBps: 0, minFeePesewas: 0n, usesProducts: false },
  DATA: { kind: 'DATA', label: 'Data bundle', direction: 'DEBIT', providers: ['MTN', 'TELECEL', 'AT'], target: 'phone', feeBps: 0, minFeePesewas: 0n, usesProducts: true },
  ECG: { kind: 'ECG', label: 'Electricity (ECG prepaid)', direction: 'DEBIT', providers: ['ECG'], target: 'meter', feeBps: 0, minFeePesewas: 0n, usesProducts: false },
  WATER: { kind: 'WATER', label: 'Water (GWL)', direction: 'DEBIT', providers: ['GWL'], target: 'water_account', feeBps: 0, minFeePesewas: 0n, usesProducts: false },
  TV: { kind: 'TV', label: 'TV subscription', direction: 'DEBIT', providers: ['DSTV', 'GOTV'], target: 'smartcard', feeBps: 0, minFeePesewas: 0n, usesProducts: true },
};

export type RemitCountry = 'GH' | 'KE' | 'NG' | 'ZA';

export interface RemitMethodSpec {
  kind: 'MOMO_PAYOUT' | 'BANK_PAYOUT';
  providers: string[];
  target: 'phone' | 'bank_account';
  minFeeMinor: bigint;
}

export interface RemitCorridorSpec {
  country: RemitCountry;
  name: string;
  currency: string;
  dialCode: string;
  mobile: RegExp;
  bankAccount: RegExp;
  maxMinor: bigint;
  methods: RemitMethodSpec[];
}

export const REMIT_CORRIDORS: Record<RemitCountry, RemitCorridorSpec> = {
  GH: {
    country: 'GH',
    name: 'Ghana',
    currency: 'GHS',
    dialCode: '233',
    mobile: /^[1-9]\d{8}$/,
    bankAccount: /^\d{10,16}$/,
    maxMinor: SANDBOX_MAX_GHS_PESEWAS,
    methods: [
      { kind: 'MOMO_PAYOUT', providers: ['MTN', 'TELECEL', 'AT'], target: 'phone', minFeeMinor: 100n },
      { kind: 'BANK_PAYOUT', providers: ['GCB', 'ECOBANK', 'STANBIC', 'ABSA', 'FIDELITY'], target: 'bank_account', minFeeMinor: 200n },
    ],
  },
  KE: {
    country: 'KE',
    name: 'Kenya',
    currency: 'KES',
    dialCode: '254',
    mobile: /^[17]\d{8}$/,
    bankAccount: /^\d{10,14}$/,
    maxMinor: 17_000_000n,
    methods: [
      { kind: 'MOMO_PAYOUT', providers: ['MPESA', 'AIRTEL_KE'], target: 'phone', minFeeMinor: 1_000n },
      { kind: 'BANK_PAYOUT', providers: ['EQUITY', 'KCB', 'COOP', 'NCBA', 'STANBIC'], target: 'bank_account', minFeeMinor: 2_000n },
    ],
  },
  NG: {
    country: 'NG',
    name: 'Nigeria',
    currency: 'NGN',
    dialCode: '234',
    mobile: /^[789]\d{9}$/,
    bankAccount: /^\d{10}$/,
    maxMinor: 175_000_000n,
    methods: [
      { kind: 'BANK_PAYOUT', providers: ['ACCESS', 'GTBANK', 'ZENITH', 'FIRSTBANK', 'UBA'], target: 'bank_account', minFeeMinor: 20_000n },
      { kind: 'MOMO_PAYOUT', providers: ['OPAY', 'PALMPAY', 'MONIEPOINT'], target: 'phone', minFeeMinor: 10_000n },
    ],
  },
  ZA: {
    country: 'ZA',
    name: 'South Africa',
    currency: 'ZAR',
    dialCode: '27',
    mobile: /^[6-8]\d{8}$/,
    bankAccount: /^\d{9,11}$/,
    maxMinor: 2_200_000n,
    methods: [{ kind: 'BANK_PAYOUT', providers: ['FNB', 'STANDARD_BANK', 'ABSA', 'NEDBANK', 'CAPITEC'], target: 'bank_account', minFeeMinor: 300n }],
  },
};

export const REMIT_CURRENCIES = [...new Set(Object.values(REMIT_CORRIDORS).map((c) => c.currency))];

export const SANDBOX_PRODUCTS: SandboxProduct[] = [
  { id: 'MTN_DATA_1GB', provider: 'MTN', label: '1 GB, 30 days', priceGhsPesewas: 1_000n },
  { id: 'MTN_DATA_5GB', provider: 'MTN', label: '5 GB, 30 days', priceGhsPesewas: 4_000n },
  { id: 'TELECEL_DATA_1GB', provider: 'TELECEL', label: '1 GB, 30 days', priceGhsPesewas: 1_000n },
  { id: 'TELECEL_DATA_5GB', provider: 'TELECEL', label: '5 GB, 30 days', priceGhsPesewas: 4_000n },
  { id: 'AT_DATA_1GB', provider: 'AT', label: '1 GB, 30 days', priceGhsPesewas: 1_000n },
  { id: 'AT_DATA_5GB', provider: 'AT', label: '5 GB, 30 days', priceGhsPesewas: 4_000n },
  { id: 'DSTV_COMPACT', provider: 'DSTV', label: 'Compact, 1 month', priceGhsPesewas: 25_000n },
  { id: 'GOTV_MAX', provider: 'GOTV', label: 'Max, 1 month', priceGhsPesewas: 12_000n },
];

export class SandboxInputError extends Error {
  constructor(readonly field: string) {
    super(`invalid ${field}`);
  }
}

const TARGETS: Record<SandboxKindSpec['target'], RegExp> = {
  phone: /^\+233[1-9]\d{8}$/,
  bank_account: /^\d{10,16}$/,
  meter: /^\d{11}$/,
  water_account: /^\d{10,13}$/,
  smartcard: /^\d{10}$/,
};

export function normalizePhone(raw: string, dialCode: string, national: RegExp): string | null {
  const compact = raw.replace(/[\s-]/g, '');
  let local: string | null = null;
  if (compact.startsWith(`+${dialCode}`)) local = compact.slice(dialCode.length + 1);
  else if (compact.startsWith(dialCode) && national.test(compact.slice(dialCode.length))) local = compact.slice(dialCode.length);
  else if (compact.startsWith('0')) local = compact.slice(1);
  else local = compact;
  if (!national.test(local)) return null;
  return `+${dialCode}${local}`;
}

export function normalizeGhanaPhone(raw: string): string | null {
  const compact = raw.replace(/[\s-]/g, '');
  if (!/^(0\d{9}|233\d{9}|\+233\d{9})$/.test(compact)) return null;
  return normalizePhone(compact, '233', REMIT_CORRIDORS.GH.mobile);
}

export function parseMinor(value: string, max: bigint, field: string): bigint {
  if (!/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(value)) throw new SandboxInputError(field);
  const [w, f = ''] = value.split('.');
  const minor = BigInt(w!) * 100n + BigInt(f.padEnd(2, '0'));
  if (minor <= 0n || minor > max) throw new SandboxInputError(field);
  return minor;
}

export function parseGhs(value: string): bigint {
  return parseMinor(value, SANDBOX_MAX_GHS_PESEWAS, 'amountGhs');
}

export function parseRate(value: string): bigint {
  if (!/^[1-9]\d{0,5}(\.\d{1,4})?$/.test(value)) throw new Error('simulated rate must be a positive decimal with up to 4 places');
  const [w, f = ''] = value.split('.');
  return BigInt(w!) * 10_000n + BigInt(f.padEnd(4, '0'));
}

export function pesewasToDemoUnits(pesewas: bigint, rateScaled: bigint): bigint {
  return (pesewas * 10n ** BigInt(SANDBOX_DECIMALS) * 10_000n) / (rateScaled * 100n);
}

export function formatGhs(pesewas: bigint): string {
  const f = (pesewas % 100n).toString().padStart(2, '0');
  return `${pesewas / 100n}.${f}`;
}

export interface SandboxRequest {
  kind: string;
  provider?: string | null;
  target: string;
  amountGhs?: string | null;
  amountLocal?: string | null;
  country?: string | null;
  productId?: string | null;
}

export interface SandboxQuote {
  kind: SandboxKind;
  direction: SandboxDirection;
  provider: string;
  target: string;
  productId: string | null;
  productLabel: string | null;
  country: RemitCountry;
  currency: string;
  amountMinor: bigint;
  feeMinor: bigint;
  totalMinor: bigint;
  amountUnits: bigint;
  feeUnits: bigint;
  totalUnits: bigint;
  rate: string;
}

export function sandboxQuote(req: SandboxRequest, rate: string): SandboxQuote {
  const spec = SANDBOX_KINDS[req.kind as SandboxKind];
  if (!spec) throw new SandboxInputError('kind');
  const corridor = REMIT_CORRIDORS[(req.country ?? 'GH') as RemitCountry];
  const payout = spec.kind === 'MOMO_PAYOUT' || spec.kind === 'BANK_PAYOUT';
  if (!corridor || (!payout && corridor.country !== 'GH')) throw new SandboxInputError('country');
  const method = payout ? corridor.methods.find((m) => m.kind === spec.kind) : null;
  if (payout && !method) throw new SandboxInputError('kind');
  const providers = method?.providers ?? spec.providers;
  const provider = req.provider ?? (providers.length === 1 ? providers[0]! : '');
  if (!providers.includes(provider)) throw new SandboxInputError('provider');
  let target: string | null;
  if (spec.target === 'phone') target = payout ? normalizePhone(req.target, corridor.dialCode, corridor.mobile) : normalizeGhanaPhone(req.target);
  else target = req.target.replace(/[\s-]/g, '');
  const targetRule = payout && spec.target === 'bank_account' ? corridor.bankAccount : spec.target === 'phone' ? /^\+\d{11,13}$/ : TARGETS[spec.target];
  if (!target || !targetRule.test(target)) throw new SandboxInputError('target');
  let amount: bigint;
  let product: SandboxProduct | null = null;
  if (spec.usesProducts && req.productId) {
    product = SANDBOX_PRODUCTS.find((p) => p.id === req.productId && p.provider === provider) ?? null;
    if (!product) throw new SandboxInputError('productId');
    amount = product.priceGhsPesewas;
  } else if (spec.usesProducts && spec.kind === 'DATA') {
    throw new SandboxInputError('productId');
  } else {
    const field = req.amountLocal != null ? 'amountLocal' : 'amountGhs';
    const raw = req.amountLocal ?? req.amountGhs;
    if (!raw) throw new SandboxInputError(field);
    amount = parseMinor(raw, corridor.maxMinor, field);
  }
  const minFee = method?.minFeeMinor ?? spec.minFeePesewas;
  const pct = (amount * BigInt(spec.feeBps)) / 10_000n;
  const fee = spec.feeBps === 0 ? 0n : pct > minFee ? pct : minFee;
  const rateScaled = parseRate(rate);
  const amountUnits = pesewasToDemoUnits(amount, rateScaled);
  const feeUnits = pesewasToDemoUnits(fee, rateScaled);
  if (amountUnits <= 0n) throw new SandboxInputError(req.amountLocal != null ? 'amountLocal' : 'amountGhs');
  return {
    kind: spec.kind,
    direction: spec.direction,
    provider,
    target,
    productId: product?.id ?? null,
    productLabel: product?.label ?? null,
    country: corridor.country,
    currency: corridor.currency,
    amountMinor: amount,
    feeMinor: fee,
    totalMinor: amount + fee,
    amountUnits,
    feeUnits,
    totalUnits: amountUnits + feeUnits,
    rate,
  };
}

export function sandboxOutcome(target: string): SandboxOutcome {
  if (target.endsWith('0000')) return 'FAILED';
  if (target.endsWith('1111')) return 'REVIEW';
  return 'SUCCEEDED';
}

export function sampleEcgToken(digits: string): string {
  return `PILOT-${digits.slice(0, 20).match(/.{4}/g)!.join('-')}`;
}
