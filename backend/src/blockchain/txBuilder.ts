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
  totalRaised: bigint;
  beneficiaryAddress: string;
  treasuryAddress: string;
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
  if (params.campaignUtxos.some(hasTokenData)) {
    throw new Error('token-utxo-not-supported');
  }
  if (params.totalRaised <= 0n) {
    throw new Error('campaign-funds-empty');
  }

  const fixedFee = params.fixedFee ?? 500n;
  const dustLimit = params.dustLimit ?? 546n;
  const totalInput = params.campaignUtxos.reduce((acc, utxo) => acc + utxo.value, 0n);
  const required = params.totalRaised + fixedFee;
  if (totalInput < required) {
    throw new Error('insufficient-funds');
  }

  let change = totalInput - required;
  let feePaid = fixedFee;
  if (change > 0n && change < dustLimit) {
    feePaid += change;
    change = 0n;
  }

  const treasuryCut = params.totalRaised / 100n;
  const beneficiaryAmount = params.totalRaised - treasuryCut;
  const beneficiaryScript = await addressToScriptPubKey(params.beneficiaryAddress);
  const treasuryScript = await addressToScriptPubKey(params.treasuryAddress);
  const changeScriptPubKey =
    change > 0n ? params.campaignUtxos[0]?.scriptPubKey || '' : '';

  const unsigned: UnsignedTx = {
    inputs: [...params.campaignUtxos],
    outputs: [
      { value: beneficiaryAmount, scriptPubKey: beneficiaryScript },
      ...(treasuryCut > 0n ? [{ value: treasuryCut, scriptPubKey: treasuryScript }] : []),
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
