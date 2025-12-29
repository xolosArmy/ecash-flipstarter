import { addressToScriptPubKey } from './ecashClient';
import type { Utxo, UnsignedTx } from './types';

// TODO: replace manual serializer and script derivation with @ecash/lib primitives.

export interface PledgeTxParams {
  contributorUtxos: Utxo[];
  covenantUtxo: Utxo;
  amount: bigint;
  covenantScriptHash: string;
  contributorAddress: string;
  beneficiaryAddress: string;
}

export interface FinalizeTxParams {
  covenantUtxo: Utxo;
  beneficiaryAddress: string;
}

export interface RefundTxParams {
  covenantUtxo: Utxo;
  refundAddress: string;
  refundAmount: bigint;
}

export interface BuiltTx {
  unsignedTx: UnsignedTx;
  rawHex: string;
}

export async function buildPledgeTx(params: PledgeTxParams): Promise<BuiltTx> {
  const totalContributor = params.contributorUtxos.reduce((acc, u) => acc + u.value, 0n);
  const isGenesis =
    !params.covenantUtxo.txid ||
    /^0+$/.test(params.covenantUtxo.txid) ||
    params.covenantUtxo.value === 0n ||
    params.covenantUtxo.scriptPubKey === '51';
  const totalInput = totalContributor + (isGenesis ? 0n : params.covenantUtxo.value);
  const newCovenantValue = (isGenesis ? 0n : params.covenantUtxo.value) + params.amount;
  if (totalInput < newCovenantValue) throw new Error('insufficient-funds-for-pledge');

  const covenantScript = isGenesis
    ? await addressToScriptPubKey(params.beneficiaryAddress)
    : params.covenantUtxo.scriptPubKey;
  const change = totalInput - newCovenantValue;
  const changeScript = change > 0n ? await addressToScriptPubKey(params.contributorAddress) : '';

  const unsigned: UnsignedTx = {
    inputs: isGenesis ? [...params.contributorUtxos] : [...params.contributorUtxos, params.covenantUtxo],
    outputs: [
      { value: newCovenantValue, scriptPubKey: covenantScript },
      ...(change > 0n ? [{ value: change, scriptPubKey: changeScript }] : []),
    ],
  };
  return { unsignedTx: unsigned, rawHex: serializeUnsignedTx(unsigned) };
}

export async function buildFinalizeTx(params: FinalizeTxParams): Promise<BuiltTx> {
  const beneficiaryScript = await addressToScriptPubKey(params.beneficiaryAddress);
  const unsigned: UnsignedTx = {
    inputs: [params.covenantUtxo],
    outputs: [{ value: params.covenantUtxo.value, scriptPubKey: beneficiaryScript }],
  };
  return { unsignedTx: unsigned, rawHex: serializeUnsignedTx(unsigned) };
}

export async function buildRefundTx(params: RefundTxParams): Promise<BuiltTx> {
  if (params.refundAmount > params.covenantUtxo.value) throw new Error('refund-too-large');
  const refundScript = await addressToScriptPubKey(params.refundAddress);
  const remaining = params.covenantUtxo.value - params.refundAmount;

  const outputs = [{ value: params.refundAmount, scriptPubKey: refundScript }];
  if (remaining > 0n) {
    outputs.push({ value: remaining, scriptPubKey: params.covenantUtxo.scriptPubKey });
  }

  const unsigned: UnsignedTx = {
    inputs: [params.covenantUtxo],
    outputs,
  };
  return { unsignedTx: unsigned, rawHex: serializeUnsignedTx(unsigned) };
}

function serializeUnsignedTx(unsignedTx: UnsignedTx): string {
  const version = 2;
  const locktime = unsignedTx.locktime ?? 0;
  const chunks: number[] = [];

  writeUInt32LE(chunks, version);
  writeVarInt(chunks, unsignedTx.inputs.length);
  for (const input of unsignedTx.inputs) {
    writeTxid(chunks, input.txid);
    writeUInt32LE(chunks, input.vout);
    writeVarInt(chunks, 0); // empty scriptSig for unsigned
    writeUInt32LE(chunks, 0xffffffff); // sequence
  }

  writeVarInt(chunks, unsignedTx.outputs.length);
  for (const output of unsignedTx.outputs) {
    writeUInt64LE(chunks, output.value);
    const scriptBytes = hexToBytes(output.scriptPubKey);
    writeVarInt(chunks, scriptBytes.length);
    chunks.push(...scriptBytes);
  }

  writeUInt32LE(chunks, locktime);
  return Buffer.from(chunks).toString('hex');
}

function writeUInt32LE(arr: number[], value: number) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  arr.push(...buf);
}

function writeUInt64LE(arr: number[], value: bigint) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  arr.push(...buf);
}

function writeVarInt(arr: number[], value: number) {
  if (value < 0xfd) {
    arr.push(value);
  } else if (value <= 0xffff) {
    arr.push(0xfd, value & 0xff, (value >> 8) & 0xff);
  } else if (value <= 0xffffffff) {
    arr.push(0xfe, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
  } else {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(value));
    arr.push(0xff, ...buf);
  }
}

function writeTxid(arr: number[], txid: string) {
  const bytes = hexToBytes(txid).reverse(); // txid is big-endian; wire format little-endian
  arr.push(...bytes);
}

function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return bytes;
}
