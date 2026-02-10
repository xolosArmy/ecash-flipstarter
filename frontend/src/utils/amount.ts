export const SATS_PER_XEC = 100;

type AmountInput = number | string | bigint | null | undefined;
type AmountDisplayInput = AmountInput;

interface FormatXecOptions {
  locale?: string;
  fallback?: string;
}

function toFiniteNumber(value: AmountDisplayInput): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'bigint') return Number(value);
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export function satsToXec(sats: AmountInput): number {
  const parsed = toFiniteNumber(sats);
  if (parsed === null) return 0;
  return parsed / SATS_PER_XEC;
}

export function xecToSats(xec: AmountInput): number {
  const parsed = toFiniteNumber(xec);
  if (parsed === null) return 0;
  return Math.round(parsed * SATS_PER_XEC);
}

export function formatXecFromSats(
  sats: AmountDisplayInput,
  opts?: FormatXecOptions,
): string {
  if (sats === '') return '';
  const xec = satsToXec(sats);
  if (!Number.isFinite(xec)) return opts?.fallback ?? '0';
  return new Intl.NumberFormat(opts?.locale ?? 'es-MX', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(xec);
}

export function parseXecInputToSats(input: string): { sats: number | null; error?: string } {
  const trimmed = input.trim();
  if (!trimmed) return { sats: null };

  const normalized = trimmed.replace(',', '.');
  if (!/^\d*\.?\d*$/.test(normalized) || normalized === '.') {
    return { sats: null, error: 'Monto inválido' };
  }

  const [, decimals = ''] = normalized.split('.');
  if (decimals.length > 2) {
    return { sats: null, error: 'Máximo 2 decimales' };
  }

  return { sats: xecToSats(normalized) };
}
