import crypto from 'crypto';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { secp256k1 } from '@noble/curves/secp256k1';
import { addressToScriptPubKey } from './ecashClient';
import type { Utxo, UnsignedTx } from './types';

// TODO: replace manual serializer and script derivation with @ecash/lib primitives.

export interface PledgeTxParams {
  contributorUtxos: Utxo[];
  covenantUtxo: Utxo;
  amount: bigint;
  covenantScriptHash: string;
  contributorAddress: string;
  beneficiaryAddress?: string;
  campaignScriptPubKey?: string;
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
  fee?: bigint;
}

export interface SimplePaymentTxParams {
  contributorUtxos: Utxo[];
  amount: bigint;
  contributorAddress: string;
  beneficiaryAddress: string;
  fixedFee?: bigint;
  feeRateSatsPerByte?: bigint;
  dustLimit?: bigint;
}

export interface PayoutTxParams {
  campaignUtxos: Utxo[];
  gasUtxo: Utxo;
  gasAddress: string;
  totalRaised: bigint;
  beneficiaryAddress: string;
  fixedFee?: bigint;
  dustLimit?: bigint;
}

const MIN_ABSOLUTE_FEE = 500n;
const MIN_RELAY_FEE_PER_KB = 1000n;
const DEFAULT_SIMPLE_PAYMENT_FEE_RATE_SATS_PER_BYTE = 2n;

export async function buildPledgeTx(params: PledgeTxParams): Promise<BuiltTx> {
  // Guard against accidental token/baton inputs for pledge construction.
  if (params.contributorUtxos.some(hasTokenData)) {
    throw new Error('token-utxo-not-supported');
  }

  const totalInput = params.contributorUtxos.reduce((acc, u) => acc + u.value, 0n);
  const campaignScript = await resolveCampaignScriptPubKey(params);
  const outputs: UnsignedTx['outputs'] = [{ value: params.amount, scriptPubKey: campaignScript }];

  const feeNoChange = calculateMinRequiredFee(params.contributorUtxos, outputs);
  if (totalInput < params.amount + feeNoChange) {
    throw new Error('insufficient-funds');
  }

  const changeScript = await addressToScriptPubKey(params.contributorAddress);
  let fee = feeNoChange;
  let change = totalInput - params.amount - feeNoChange;
  if (change > 0n) {
    const feeWithChange = calculateMinRequiredFee(params.contributorUtxos, [
      ...outputs,
      { value: 1n, scriptPubKey: changeScript },
    ]);
    const changeWithFee = totalInput - params.amount - feeWithChange;
    if (changeWithFee > 0n) {
      fee = feeWithChange;
      change = changeWithFee;
    } else {
      fee = totalInput - params.amount;
      change = 0n;
    }
  }

  const unsigned: UnsignedTx = {
    inputs: [...params.contributorUtxos],
    outputs: [
      ...outputs,
      ...(change > 0n ? [{ value: change, scriptPubKey: changeScript }] : []),
    ],
  };
  return { unsignedTx: unsigned, rawHex: serializeUnsignedTx(unsigned), fee };
}

export async function buildSimplePaymentTx(
  params: SimplePaymentTxParams
): Promise<BuiltTx & { fee: bigint }> {
  if (params.contributorUtxos.some(hasTokenData)) {
    throw new Error('token-utxo-not-supported');
  }
  const dustLimit = params.dustLimit ?? 546n;
  const totalInput = params.contributorUtxos.reduce((acc, utxo) => acc + utxo.value, 0n);
  const useDynamicFee = params.feeRateSatsPerByte !== undefined;

  let feePaid: bigint;
  let change: bigint;
  if (useDynamicFee) {
    const feeRate = params.feeRateSatsPerByte ?? DEFAULT_SIMPLE_PAYMENT_FEE_RATE_SATS_PER_BYTE;
    if (feeRate <= 0n) {
      throw new Error('invalid-fee-rate');
    }
    const inputCount = params.contributorUtxos.length;
    feePaid = estimateSimplePaymentFee(inputCount, 2, feeRate);
    change = totalInput - params.amount - feePaid;

    // If 2 outputs are not affordable, fall back to 1 output and consume remainder as additional fee.
    if (change < 0n) {
      const oneOutputFee = estimateSimplePaymentFee(inputCount, 1, feeRate);
      const remainder = totalInput - params.amount - oneOutputFee;
      if (remainder < 0n) {
        throw new Error(
          `insufficient-funds-for-fee: need ${params.amount + oneOutputFee} sats, have ${totalInput} sats`
        );
      }
      feePaid = oneOutputFee + remainder;
      change = 0n;
    }
  } else {
    const fixedFee = params.fixedFee ?? 500n;
    const required = params.amount + fixedFee;
    if (totalInput < required) throw new Error('insufficient-funds');

    change = totalInput - required;
    feePaid = fixedFee;
  }

  if (change > 0n && change < dustLimit) {
    feePaid += change;
    change = 0n;
  }

  const beneficiaryScript = await addressToScriptPubKey(params.beneficiaryAddress);
  const changeScript = change > 0n ? await addressToScriptPubKey(params.contributorAddress) : '';
  const unsigned: UnsignedTx = {
    inputs: [...params.contributorUtxos],
    outputs: [
      { value: params.amount, scriptPubKey: beneficiaryScript },
      ...(change > 0n ? [{ value: change, scriptPubKey: changeScript }] : []),
    ],
  };
  return { unsignedTx: unsigned, rawHex: serializeUnsignedTx(unsigned), fee: feePaid };
}

export async function buildPayoutTx(
  params: PayoutTxParams
): Promise<BuiltTx & { fee: bigint; treasuryCut: bigint; beneficiaryAmount: bigint }> {
  if (params.campaignUtxos.some(hasTokenData) || hasTokenData(params.gasUtxo)) {
    throw new Error('token-utxo-not-supported');
  }
  if (!params.gasUtxo.scriptPubKey) {
    throw new Error('gas-input-missing-scriptpubkey');
  }
  if (params.totalRaised <= 0n) {
    throw new Error('campaign-funds-empty');
  }

  const fixedFee = params.fixedFee ?? 500n;
  const dustLimit = params.dustLimit ?? 546n;
  if (params.gasUtxo.value < fixedFee) {
    throw new Error('gas-wallet-insufficient-fee');
  }

  let change = params.gasUtxo.value - fixedFee;
  let feePaid = fixedFee;
  if (change > 0n && change < dustLimit) {
    feePaid += change;
    change = 0n;
  }

  // Treasury cut is temporarily disabled because the current covenant finalize path
  // only matches a single beneficiary output and does not explicitly support a split.
  const treasuryCut = 0n;
  const beneficiaryAmount = params.totalRaised;
  const beneficiaryScript = await addressToScriptPubKey(params.beneficiaryAddress);
  const changeScriptPubKey = change > 0n ? await addressToScriptPubKey(params.gasAddress) : '';

  const unsigned: UnsignedTx = {
    inputs: [...params.campaignUtxos, params.gasUtxo],
    outputs: [
      { value: beneficiaryAmount, scriptPubKey: beneficiaryScript },
      ...(change > 0n && changeScriptPubKey
        ? [{ value: change, scriptPubKey: changeScriptPubKey }]
        : []),
    ],
  };
  return {
    unsignedTx: unsigned,
    rawHex: serializeUnsignedTx(unsigned),
    fee: feePaid,
    treasuryCut,
    beneficiaryAmount,
  };
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

export async function derivePrivKeyFromSeed(mnemonic: string, index = 0): Promise<Buffer> {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(`m/44'/1899'/0'/0/${index}`);
  if (!child.privateKey) {
    throw new Error('No se pudo derivar la clave privada');
  }
  return Buffer.from(child.privateKey);
}

export function signHybridPayoutTx(
  unsignedTx: UnsignedTx,
  privKey: Buffer,
  redeemScriptHex: string,
  gasInputIndex = unsignedTx.inputs.length - 1
): string {
  if (unsignedTx.inputs.length < 2) {
    throw new Error('hybrid-payout-requires-gas-input');
  }
  if (gasInputIndex < 0 || gasInputIndex >= unsignedTx.inputs.length) {
    throw new Error('invalid-gas-input-index');
  }
  if (!unsignedTx.inputs[gasInputIndex]?.scriptPubKey) {
    throw new Error('gas-input-missing-scriptpubkey');
  }

  const publicKey = Buffer.from(secp256k1.getPublicKey(privKey, true));
  const sighashType = 0x41;
  const chunks: number[] = [];

  writeUInt32LE(chunks, 2);

  const prevouts: number[] = [];
  for (const input of unsignedTx.inputs) {
    writeTxid(prevouts, input.txid);
    writeUInt32LE(prevouts, input.vout);
  }
  chunks.push(...hash256(Buffer.from(prevouts)));

  const sequences: number[] = [];
  for (let i = 0; i < unsignedTx.inputs.length; i += 1) {
    writeUInt32LE(sequences, i === gasInputIndex ? 0xfffffffe : 0xffffffff);
  }
  chunks.push(...hash256(Buffer.from(sequences)));

  const gasInput = unsignedTx.inputs[gasInputIndex];
  writeTxid(chunks, gasInput.txid);
  writeUInt32LE(chunks, gasInput.vout);

  const scriptBytes = hexToBytes(gasInput.scriptPubKey);
  writeVarInt(chunks, scriptBytes.length);
  chunks.push(...scriptBytes);

  writeUInt64LE(chunks, gasInput.value);
  writeUInt32LE(chunks, 0xfffffffe);

  const outputs: number[] = [];
  for (const output of unsignedTx.outputs) {
    writeUInt64LE(outputs, output.value);
    const outBytes = hexToBytes(output.scriptPubKey);
    writeVarInt(outputs, outBytes.length);
    outputs.push(...outBytes);
  }
  chunks.push(...hash256(Buffer.from(outputs)));

  writeUInt32LE(chunks, unsignedTx.locktime ?? 0);
  writeUInt32LE(chunks, sighashType);

  const sighash = hash256(Buffer.from(chunks));
  const sig64 = secp256k1.sign(sighash, privKey).toCompactRawBytes();
  const derSignature = Buffer.concat([toDerSignature(sig64), Buffer.from([sighashType])]);
  const redeemBytes = hexToBytes(redeemScriptHex);

  const finalTx: number[] = [];
  writeUInt32LE(finalTx, 2);
  writeVarInt(finalTx, unsignedTx.inputs.length);

  for (let i = 0; i < unsignedTx.inputs.length; i += 1) {
    const input = unsignedTx.inputs[i];
    writeTxid(finalTx, input.txid);
    writeUInt32LE(finalTx, input.vout);

    const scriptSig =
      i === gasInputIndex
        ? [
          ...encodePushData([...derSignature]),
          ...derSignature,
          ...encodePushData([...publicKey]),
          ...publicKey,
        ]
        : [0x51, ...encodePushData(redeemBytes), ...redeemBytes];

    writeVarInt(finalTx, scriptSig.length);
    finalTx.push(...scriptSig);
    writeUInt32LE(finalTx, i === gasInputIndex ? 0xfffffffe : 0xffffffff);
  }

  writeVarInt(finalTx, unsignedTx.outputs.length);
  for (const output of unsignedTx.outputs) {
    writeUInt64LE(finalTx, output.value);
    const outBytes = hexToBytes(output.scriptPubKey);
    writeVarInt(finalTx, outBytes.length);
    finalTx.push(...outBytes);
  }

  writeUInt32LE(finalTx, unsignedTx.locktime ?? 0);
  return Buffer.from(finalTx).toString('hex');
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

function encodePushData(bytes: number[]): number[] {
  if (bytes.length <= 0x4b) {
    return [bytes.length];
  }
  if (bytes.length <= 0xff) {
    return [0x4c, bytes.length];
  }
  if (bytes.length <= 0xffff) {
    return [0x4d, bytes.length & 0xff, (bytes.length >> 8) & 0xff];
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(bytes.length, 0);
  return [0x4e, ...buf];
}

function hash256(buffer: Uint8Array): Buffer {
  const first = crypto.createHash('sha256').update(buffer).digest();
  return crypto.createHash('sha256').update(first).digest();
}

function toDerSignature(signature: Uint8Array): Buffer {
  const r = trimDerInteger(Buffer.from(signature.slice(0, 32)));
  const s = trimDerInteger(Buffer.from(signature.slice(32, 64)));

  const rElement = Buffer.concat([Buffer.from([0x02, r.length]), r]);
  const sElement = Buffer.concat([Buffer.from([0x02, s.length]), s]);
  const body = Buffer.concat([rElement, sElement]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function trimDerInteger(value: Buffer): Buffer {
  let trimmed = value;
  while (trimmed.length > 1 && trimmed[0] === 0x00 && (trimmed[1] & 0x80) === 0) {
    trimmed = Buffer.from(trimmed.subarray(1));
  }
  if (trimmed[0] & 0x80) {
    return Buffer.concat([Buffer.from([0x00]), trimmed]);
  }
  return Buffer.from(trimmed);
}

function hasTokenData(utxo: Utxo): boolean {
  return Boolean(utxo.token || utxo.slpToken || utxo.tokenStatus || utxo.plugins?.token);
}

async function resolveCampaignScriptPubKey(params: PledgeTxParams): Promise<string> {
  const scriptCandidate = params.campaignScriptPubKey?.trim();
  if (scriptCandidate) {
    return scriptCandidate;
  }
  const beneficiaryAddress = params.beneficiaryAddress?.trim();
  if (!beneficiaryAddress) {
    throw new Error('beneficiary-address-required');
  }
  return addressToScriptPubKey(beneficiaryAddress);
}

function calculateMinRequiredFee(inputs: Utxo[], outputs: UnsignedTx['outputs']): bigint {
  const estimatedSize = estimateSignedTxSize(inputs, outputs);
  const relayMinFee = (estimatedSize * MIN_RELAY_FEE_PER_KB + 999n) / 1000n;
  return relayMinFee > MIN_ABSOLUTE_FEE ? relayMinFee : MIN_ABSOLUTE_FEE;
}

function estimateSignedTxSize(inputs: Utxo[], outputs: UnsignedTx['outputs']): bigint {
  let size = 4n + 4n;
  size += BigInt(varIntSize(inputs.length));
  for (const input of inputs) {
    const scriptSigSize = estimateScriptSigSize(input.scriptPubKey);
    size += 36n;
    size += BigInt(varIntSize(scriptSigSize));
    size += BigInt(scriptSigSize);
    size += 4n;
  }
  size += BigInt(varIntSize(outputs.length));
  for (const output of outputs) {
    const scriptSize = output.scriptPubKey.length / 2;
    size += 8n;
    size += BigInt(varIntSize(scriptSize));
    size += BigInt(scriptSize);
  }
  return size;
}

function estimateScriptSigSize(scriptPubKey: string): number {
  if (/^76a914[0-9a-f]{40}88ac$/i.test(scriptPubKey)) {
    return 107;
  }
  return 140;
}

function varIntSize(value: number): number {
  if (value < 0xfd) return 1;
  if (value <= 0xffff) return 3;
  if (value <= 0xffffffff) return 5;
  return 9;
}

function estimateSimplePaymentFee(
  inputCount: number,
  outputCount: number,
  feeRateSatsPerByte: bigint
): bigint {
  const estimatedSize = BigInt(inputCount * 148 + outputCount * 34 + 10);
  const relayMinFee = (estimatedSize * MIN_RELAY_FEE_PER_KB + 999n) / 1000n;
  const sizeBasedFee = estimatedSize * feeRateSatsPerByte;
  if (sizeBasedFee < MIN_ABSOLUTE_FEE) {
    return MIN_ABSOLUTE_FEE > relayMinFee ? MIN_ABSOLUTE_FEE : relayMinFee;
  }
  return sizeBasedFee > relayMinFee ? sizeBasedFee : relayMinFee;
}
