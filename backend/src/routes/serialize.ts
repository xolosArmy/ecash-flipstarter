import type { BuiltTx } from '../blockchain/txBuilder';

export function serializeBuiltTx<T extends BuiltTx>(built: T) {
  return {
    ...built,
    unsignedTx: {
      ...built.unsignedTx,
      inputs: built.unsignedTx.inputs.map((i) => ({ ...i, value: i.value.toString() })),
      outputs: built.unsignedTx.outputs.map((o) => ({ ...o, value: o.value.toString() })),
      locktime: built.unsignedTx.locktime,
    },
    rawHex: built.rawHex,
    unsignedTxHex: built.rawHex,
    // carry any extra fields (e.g., nextCovenantValue) converting BigInt to string
    ...(typeof (built as any).nextCovenantValue !== 'undefined'
      ? { nextCovenantValue: (built as any).nextCovenantValue.toString() }
      : {}),
    ...(typeof (built as any).fee !== 'undefined' ? { fee: (built as any).fee.toString() } : {}),
  };
}
