const SATS_PER_XEC = 100n;

function parseAmountXecToSats(raw: unknown): bigint {
  const normalized = String(raw ?? '').trim().replace(',', '.');
  if (!normalized) {
    throw new Error('amountXec-required');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error('amountXec-invalid');
  }

  const [wholePart, decimalPart = ''] = normalized.split('.');
  const whole = BigInt(wholePart);
  const decimals = BigInt((decimalPart + '00').slice(0, 2));
  return whole * SATS_PER_XEC + decimals;
}

export function parsePledgeAmountSats(body: unknown): bigint {
  const record = (body ?? {}) as Record<string, unknown>;

  if (record.amountXec !== undefined && record.amountXec !== null && String(record.amountXec).trim() !== '') {
    const sats = parseAmountXecToSats(record.amountXec);
    if (sats <= 0n) {
      throw new Error('amount-required');
    }
    return sats;
  }

  const amountRaw = String(record.amount ?? '').trim();
  if (!amountRaw) {
    throw new Error('amount-required');
  }

  let sats: bigint;
  try {
    sats = BigInt(amountRaw);
  } catch {
    throw new Error('amount-invalid');
  }

  if (sats <= 0n) {
    throw new Error('amount-required');
  }
  return sats;
}

export function parsePledgeMessage(body: unknown): string | undefined {
  const rawMessage = typeof (body as { message?: unknown } | null)?.message === 'string'
    ? ((body as { message: string }).message || '').trim()
    : '';
  if (rawMessage.length > 200) {
    throw new Error('message-too-long');
  }
  return rawMessage || undefined;
}

