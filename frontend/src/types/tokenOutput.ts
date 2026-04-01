export type AlpTokenPayload = {
  protocol: 'ALP';
  tokenId: string;
  amount: string;
};

export type LegacyCompatibleAlpTokenPayload = {
  protocol?: unknown;
  tokenId?: unknown;
  amount?: unknown;
  tokenAmount?: unknown;
};

export type TokenOutput = {
  address: string;
  valueSats: number | string;
  token?: AlpTokenPayload;
};

export type WalletConnectTokenOutput = {
  address: string;
  valueSats: number | string | bigint;
  token?: AlpTokenPayload;
};

export type TokenOutputLike = {
  address: string;
  valueSats: number | string | bigint;
  token?: AlpTokenPayload | LegacyCompatibleAlpTokenPayload;
};

export function normalizeAlpTokenPayload(
  token: unknown,
  options?: { fallbackProtocol?: boolean },
): AlpTokenPayload | undefined {
  if (!token || typeof token !== 'object') return undefined;

  const candidate = token as LegacyCompatibleAlpTokenPayload;
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
    return undefined;
  }

  return {
    protocol,
    tokenId,
    amount,
  };
}

export function normalizeTokenOutput(
  output: TokenOutputLike,
  options?: { fallbackProtocol?: boolean; stringifyValueSats?: boolean },
): TokenOutput | undefined {
  if (!output || typeof output !== 'object') return undefined;

  const address = typeof output.address === 'string' ? output.address.trim() : '';
  if (!address) return undefined;

  const valueSource = output.valueSats;
  const valueSats = options?.stringifyValueSats
    ? typeof valueSource === 'bigint'
      ? valueSource.toString()
      : String(valueSource)
    : typeof valueSource === 'bigint'
      ? valueSource.toString()
      : typeof valueSource === 'string'
        ? Number(valueSource)
        : valueSource;

  if (
    (typeof valueSats === 'number' && (!Number.isFinite(valueSats) || valueSats <= 0 || !Number.isInteger(valueSats)))
    || (typeof valueSats === 'string' && !/^\d+$/.test(valueSats))
  ) {
    return undefined;
  }

  const token = normalizeAlpTokenPayload(output.token, options);

  return {
    address,
    valueSats,
    ...(token ? { token } : {}),
  };
}

export function normalizeTokenOutputs(
  outputs: TokenOutputLike[] | null | undefined,
  options?: { fallbackProtocol?: boolean; stringifyValueSats?: boolean },
): TokenOutput[] {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    return [];
  }

  return outputs
    .map((output) => normalizeTokenOutput(output, options))
    .filter((output): output is TokenOutput => Boolean(output));
}
