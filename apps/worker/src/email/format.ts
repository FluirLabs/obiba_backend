const TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Accra', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export function formatTime(iso: string): string {
  const parts = Object.fromEntries(TIME.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} GMT`;
}

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatDecimal(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const trimmed = fraction.slice(0, 6).replace(/0+$/, '').padEnd(2, '0');
  return `${group(whole.replace(/^0+(?=\d)/, ''))}.${trimmed}`;
}

export function formatUnits(units: string, decimals: number): string {
  const digits = units.padStart(decimals + 1, '0');
  const cut = digits.length - decimals;
  return formatDecimal(decimals === 0 ? digits : `${digits.slice(0, cut)}.${digits.slice(cut)}`);
}

export function maskAddress(value: string): string {
  return value.length <= 12 ? `${value.slice(0, 2)}…${value.slice(-2)}` : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function reference(id: string): string {
  return `OB-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export function firstName(display: string | null | undefined): string | null {
  const first = display?.trim().split(/\s+/)[0];
  return first ? first.slice(0, 40) : null;
}
