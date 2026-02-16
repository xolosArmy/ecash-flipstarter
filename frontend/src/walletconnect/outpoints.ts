export type OutpointInput = {
  txid: string;
  vout: number;
};

const TXID_HEX_64 = /^[0-9a-f]{64}$/i;

export function outpointToString(input: OutpointInput): string {
  const txid = typeof input.txid === 'string' ? input.txid.trim().toLowerCase() : '';
  const vout = input.vout;
  if (!TXID_HEX_64.test(txid)) {
    throw new Error('txid inválido en inputs/outpoints.');
  }
  if (!Number.isInteger(vout) || vout < 0) {
    throw new Error('vout inválido en inputs/outpoints.');
  }
  return `${txid}:${vout}`;
}

export function normalizeOutpoints(inputs: OutpointInput[]): string[] {
  return inputs.map((input) => outpointToString(input));
}
