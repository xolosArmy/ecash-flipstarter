export const SATS_PER_XEC = 100n;

export function xecToSats(xec: number): bigint {
  if (!Number.isFinite(xec)) {
    throw new Error('xec-amount-invalid');
  }
  return BigInt(Math.round(xec * Number(SATS_PER_XEC)));
}

export function satsToXec(sats: bigint): number {
  return Number(sats) / Number(SATS_PER_XEC);
}

export function coerceAmountToSats(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? BigInt(value) : xecToSats(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim().replace(',', '.');
    if (/^\d+$/.test(normalized)) {
      return BigInt(normalized);
    }
    if (/^\d+(\.\d+)?$/.test(normalized)) {
      return xecToSats(Number(normalized));
    }
  }

  return 0n;
}
