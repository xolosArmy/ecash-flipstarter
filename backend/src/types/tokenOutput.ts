export type ActivationTokenPayload = {
  protocol: 'ALP';
  tokenId: string;
  amount: string;
};

export type ActivationOfferOutput = {
  address: string;
  valueSats: number;
  token?: ActivationTokenPayload;
};

type ActivationTokenPayloadLike = {
  protocol?: unknown;
  tokenId?: unknown;
  amount?: unknown;
  tokenAmount?: unknown;
};

export function normalizeActivationTokenPayload(
  token: unknown,
  options?: { fallbackProtocol?: boolean },
): ActivationTokenPayload | null {
  if (!token || typeof token !== 'object') return null;

  const candidate = token as ActivationTokenPayloadLike;
  const tokenId = typeof candidate.tokenId === 'string' ? candidate.tokenId.trim().toLowerCase() : '';
  const amount =
    typeof candidate.amount === 'string'
      ? candidate.amount.trim()
      : typeof candidate.tokenAmount === 'string'
        ? candidate.tokenAmount.trim()
        : '';
  const protocol =
    candidate.protocol === 'ALP'
      ? 'ALP'
      : options?.fallbackProtocol && tokenId && /^\d+$/.test(amount)
        ? 'ALP'
        : null;

  if (!protocol || !tokenId || !/^\d+$/.test(amount)) {
    return null;
  }

  return {
    protocol,
    tokenId,
    amount,
  };
}

export function normalizeActivationOfferOutput(
  entry: unknown,
  options?: { fallbackProtocol?: boolean },
): ActivationOfferOutput | null {
  if (!entry || typeof entry !== 'object') return null;

  const address = (entry as { address?: unknown }).address;
  const valueSats = (entry as { valueSats?: unknown }).valueSats;
  if (typeof address !== 'string' || !address.trim()) return null;

  const numericValue = Number(valueSats);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return null;

  const token = normalizeActivationTokenPayload((entry as { token?: unknown }).token, options);

  return {
    address,
    valueSats: Math.floor(numericValue),
    ...(token ? { token } : {}),
  };
}

export function normalizeActivationOfferOutputs(
  outputs: unknown,
  options?: { fallbackProtocol?: boolean },
): ActivationOfferOutput[] | null {
  if (!Array.isArray(outputs) || outputs.length === 0) return null;

  const normalized = outputs
    .map((entry) => normalizeActivationOfferOutput(entry, options))
    .filter((entry): entry is ActivationOfferOutput => entry !== null);

  return normalized.length > 0 ? normalized : null;
}
