export function formatXecFromSats(sats: number | string | bigint | null | undefined): string {
  try {
    if (sats === null || sats === undefined || sats === '') return '0';
    const value = typeof sats === 'bigint' ? sats : BigInt(String(sats));
    const xec = Number(value) / 100_000_000;
    if (!Number.isFinite(xec)) return '0';
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(xec);
  } catch {
    return '0';
  }
}

export function satsFromXecInput(value: string): bigint {
  try {
    const trimmed = value.trim();
    if (!trimmed) return 0n;
    const normalized = trimmed.replace(/,/g, '');
    if (!/^\d+(\.\d{0,8})?$/.test(normalized)) return 0n;
    const [whole, fraction = ''] = normalized.split('.');
    const wholePart = BigInt(whole || '0') * 100_000_000n;
    const fractionPart = BigInt((fraction + '00000000').slice(0, 8));
    return wholePart + fractionPart;
  } catch {
    return 0n;
  }
}
