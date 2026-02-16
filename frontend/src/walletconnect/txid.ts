const TXID_HEX_REGEX = /^[0-9a-f]{64}$/i;

function isTxid(value: unknown): value is string {
  return typeof value === 'string' && TXID_HEX_REGEX.test(value.trim());
}

export function extractWalletTxid(result: unknown): string | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [result];

  while (queue.length > 0) {
    const current = queue.shift();
    if (isTxid(current)) {
      return current.trim().toLowerCase();
    }
    if (!current || typeof current !== 'object') {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      for (const entry of current) {
        queue.push(entry);
      }
      continue;
    }

    const record = current as Record<string, unknown>;
    if (isTxid(record.txid)) {
      return record.txid.trim().toLowerCase();
    }
    if (isTxid(record.hash)) {
      return record.hash.trim().toLowerCase();
    }

    for (const value of Object.values(record)) {
      queue.push(value);
    }
  }

  return null;
}
