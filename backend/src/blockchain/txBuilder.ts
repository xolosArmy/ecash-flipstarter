import crypto from 'crypto';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  Ecc,
  Script as EcashScript,
  TxBuilder,
  type TxBuilderInput,
  P2PKHSignatory,
  SINGLE_ANYONECANPAY_BIP143,
  ALL_BIP143,
  pushBytesOp,
  OP_1,
  sha256d,
  flagSignature,
} from '@ecash/lib';
import { TEYOLIA_COVENANT_V1 } from '../covenants/scriptCompiler';
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
  contractVersion?: string;
  redeemScriptHex?: string;
  feeRateSatsPerByte?: bigint;
}

export interface FinalizeTxParams {
  covenantUtxo: Utxo;
  beneficiaryAddress: string;
  contractVersion?: string;
  redeemScriptHex?: string;
  beneficiaryPrivKey?: Buffer | string;
  beneficiaryPubKey?: string;
  gasUtxos?: Utxo[];
  gasChangeAddress?: string;
  gasPrivKey?: Buffer | string | null;
  fixedFee?: bigint;
}

export interface RefundTxParams {
  covenantUtxo: Utxo;
  refundAddress: string;
  refundAmount: bigint;
  contractVersion?: string;
  redeemScriptHex?: string;
  refundOraclePrivKey?: Buffer | string;
  expirationTime?: bigint | number;
  fixedFee?: bigint;
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
const SIGHASH_FORKID = 0x40;
const SIGHASH_ALL = 0x01;
const SIGHASH_SINGLE = 0x03;
const SIGHASH_ANYONECANPAY = 0x80;
const SIGHASH_ALL_FORKID = SIGHASH_ALL | SIGHASH_FORKID;
const SIGHASH_SINGLE_ANYONECANPAY_FORKID = SIGHASH_SINGLE | SIGHASH_FORKID | SIGHASH_ANYONECANPAY;
const NON_FINAL_SEQUENCE = 0xfffffffe;
const FINAL_SEQUENCE = 0xffffffff;

export async function buildPledgeTx(params: PledgeTxParams): Promise<BuiltTx> {
  // Guard against accidental token/baton inputs for pledge construction.
  if (params.contributorUtxos.some(hasTokenData)) {
    throw new Error('token-utxo-not-supported');
  }

  if (
    params.contractVersion === TEYOLIA_COVENANT_V1
    && params.redeemScriptHex
    && params.covenantUtxo.scriptPubKey
  ) {
    return buildPledgeTxV1(params);
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
  if (
    params.contractVersion === TEYOLIA_COVENANT_V1
    && params.redeemScriptHex
    && params.beneficiaryPrivKey
  ) {
    return buildFinalizeTxV1(params);
  }

  const beneficiaryScript = await addressToScriptPubKey(params.beneficiaryAddress);
  const unsigned: UnsignedTx = {
    inputs: [params.covenantUtxo],
    outputs: [{ value: params.covenantUtxo.value, scriptPubKey: beneficiaryScript }],
  };
  return { unsignedTx: unsigned, rawHex: serializeUnsignedTx(unsigned) };
}

export async function buildRefundTx(params: RefundTxParams): Promise<BuiltTx> {
  if (
    params.contractVersion === TEYOLIA_COVENANT_V1
    && params.redeemScriptHex
    && params.refundOraclePrivKey
  ) {
    return buildRefundTxV1(params);
  }

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

export function buildPledgeUnlockingScriptV1(redeemScriptHex: string): string {
  return serializeScriptChunks([
    pushHexChunk('03'),
    pushHexChunk(redeemScriptHex),
  ]);
}

export function buildFinalizeUnlockingScriptV1(
  beneficiaryFlaggedSignatureHex: string,
  beneficiarySignatureHex: string,
  preimageHex: string,
  preimageSha256Hex: string,
  output0Hex: string,
  redeemScriptHex: string
): string {
  return EcashScript.fromOps([
    pushBytesOp(new Uint8Array(Buffer.from(beneficiaryFlaggedSignatureHex, 'hex'))),
    pushBytesOp(new Uint8Array(Buffer.from(beneficiarySignatureHex, 'hex'))),
    pushBytesOp(new Uint8Array(Buffer.from(preimageHex, 'hex'))),
    pushBytesOp(new Uint8Array(Buffer.from(preimageSha256Hex, 'hex'))),
    pushBytesOp(new Uint8Array(Buffer.from(output0Hex, 'hex'))),
    OP_1,
    pushBytesOp(new Uint8Array(Buffer.from(redeemScriptHex, 'hex'))),
  ]).toHex();
}

export function buildRefundUnlockingScriptV1(
  oracleSignatureHex: string,
  redeemScriptHex: string
): string {
  return serializeScriptChunks([
    pushHexChunk(oracleSignatureHex),
    pushHexChunk('02'),
    pushHexChunk(redeemScriptHex),
  ]);
}

export function computeEcashSigHash(
  unsignedTx: UnsignedTx,
  inputIndex: number,
  coveredBytecodeHex: string,
  sighashType = SIGHASH_SINGLE_ANYONECANPAY_FORKID
): string {
  if (inputIndex < 0 || inputIndex >= unsignedTx.inputs.length) {
    throw new Error('invalid-input-index');
  }

  const baseType = sighashType & 0x1f;
  const anyoneCanPay = (sighashType & SIGHASH_ANYONECANPAY) !== 0;
  const chunks: number[] = [];

  writeUInt32LE(chunks, 2);
  chunks.push(...(anyoneCanPay ? ZERO_HASH_BYTES : hashPrevouts(unsignedTx.inputs)));
  chunks.push(...((anyoneCanPay || baseType === 0x02 || baseType === 0x03) ? ZERO_HASH_BYTES : hashSequences(unsignedTx.inputs)));

  const input = unsignedTx.inputs[inputIndex]!;
  writeTxid(chunks, input.txid);
  writeUInt32LE(chunks, input.vout);

  const coveredBytecode = hexToBytes(coveredBytecodeHex);
  writeVarInt(chunks, coveredBytecode.length);
  chunks.push(...coveredBytecode);

  writeUInt64LE(chunks, input.value);
  writeUInt32LE(chunks, input.sequence ?? FINAL_SEQUENCE);
  chunks.push(...hashOutputs(unsignedTx.outputs, inputIndex, baseType));
  writeUInt32LE(chunks, unsignedTx.locktime ?? 0);
  writeUInt32LE(chunks, sighashType);

  return hash256(Buffer.from(chunks)).toString('hex');
}

export function signFinalizeInputV1(
  unsignedTx: UnsignedTx,
  beneficiaryPrivKey: Buffer | string,
  redeemScriptHex: string,
  inputIndex = 0
): string {
  return signEcashInput(unsignedTx, beneficiaryPrivKey, redeemScriptHex, inputIndex);
}

export function signRefundInputV1(
  unsignedTx: UnsignedTx,
  refundOraclePrivKey: Buffer | string,
  redeemScriptHex: string,
  inputIndex = 0
): string {
  return signEcashInput(unsignedTx, refundOraclePrivKey, redeemScriptHex, inputIndex);
}

export function signP2pkhInput(
  unsignedTx: UnsignedTx,
  privateKey: Buffer | string,
  inputIndex: number
): string {
  const input = unsignedTx.inputs[inputIndex];
  if (!input) {
    throw new Error('invalid-input-index');
  }
  if (!input.scriptPubKey) {
    throw new Error('p2pkh-input-missing-scriptpubkey');
  }

  const privKey = asPrivKeyBuffer(privateKey);
  const publicKey = Buffer.from(secp256k1.getPublicKey(privKey, true));
  const sighash = Buffer.from(
    computeP2pkhSigHash(unsignedTx, inputIndex, input.scriptPubKey, SIGHASH_ALL_FORKID),
    'hex',
  );
  const sig64 = secp256k1.sign(sighash, privKey).toCompactRawBytes();
  const derSignature = Buffer.concat([toDerSignature(sig64), Buffer.from([SIGHASH_ALL_FORKID])]);

  return Buffer.from([
    ...encodePushData([...derSignature]),
    ...derSignature,
    ...encodePushData([...publicKey]),
    ...publicKey,
  ]).toString('hex');
}

export function serializeTx(unsignedTx: UnsignedTx): string {
  return serializeUnsignedTx(unsignedTx);
}

async function buildPledgeTxV1(params: PledgeTxParams): Promise<BuiltTx> {
  const campaignScript = await resolveCampaignScriptPubKey(params);
  const covenantInput = {
    ...params.covenantUtxo,
    scriptSig: buildPledgeUnlockingScriptV1(params.redeemScriptHex!),
    sequence: FINAL_SEQUENCE,
  };
  const contributorInputs = params.contributorUtxos.map((utxo) => ({
    ...utxo,
    sequence: FINAL_SEQUENCE,
  }));

  const nextCovenantValue = params.covenantUtxo.value + params.amount;
  const contributorTotal = params.contributorUtxos.reduce((acc, utxo) => acc + utxo.value, 0n);
  const changeScript = await addressToScriptPubKey(params.contributorAddress);
  const feeRate = params.feeRateSatsPerByte ?? DEFAULT_SIMPLE_PAYMENT_FEE_RATE_SATS_PER_BYTE;
  let outputs: UnsignedTx['outputs'] = [{ value: nextCovenantValue, scriptPubKey: campaignScript }];

  let fee = estimateTxFee(
    {
      inputs: [covenantInput, ...contributorInputs],
      outputs,
    },
    feeRate,
  );
  if (contributorTotal < params.amount + fee) {
    throw new Error('insufficient-funds');
  }

  let change = contributorTotal - params.amount - fee;
  if (change > 0n) {
    const outputsWithChange = [...outputs, { value: change, scriptPubKey: changeScript }];
    fee = estimateTxFee(
      {
        inputs: [covenantInput, ...contributorInputs],
        outputs: outputsWithChange,
      },
      feeRate,
    );
    change = contributorTotal - params.amount - fee;
    if (change > 0n) {
      outputs = outputsWithChange.map((output, index) => (index === 1 ? { ...output, value: change } : output));
    }
  }

  if (change > 0n && change < 546n) {
    fee += change;
    change = 0n;
  }
  if (change > 0n) {
    outputs = [
      outputs[0]!,
      { value: change, scriptPubKey: changeScript },
    ];
  }

  const unsignedTx: UnsignedTx = {
    inputs: [covenantInput, ...contributorInputs],
    outputs,
  };
  return { unsignedTx, rawHex: serializeUnsignedTx(unsignedTx), fee };
}

async function buildFinalizeTxV1(params: FinalizeTxParams): Promise<BuiltTx> {
  const ecc = new Ecc();
  // The preimage-based V1 finalize path now produces a much larger tx
  // (~881 bytes observed), so use a 1000 sat operational fixed fee target
  // to guarantee relay without introducing a two-pass re-sign flow.
  const feeTarget = params.fixedFee ?? 1000n;
  const gasUtxos = (params.gasUtxos ?? []).map((utxo) => {
    if (hasTokenData(utxo)) {
      throw new Error('token-utxo-not-supported');
    }
    if (!utxo.scriptPubKey) {
      throw new Error('gas-input-missing-scriptpubkey');
    }
    return { ...utxo, sequence: FINAL_SEQUENCE };
  });
  const gasTotal = gasUtxos.reduce((acc, utxo) => acc + utxo.value, 0n);
  if (gasTotal > 0n && !params.gasPrivKey) {
    throw new Error('gas-wallet-signing-key-missing');
  }

  const covenantLoss = gasTotal >= feeTarget ? 0n : feeTarget - gasTotal;
  if (covenantLoss > 1000n) {
    throw new Error('finalize-fee-cap-exceeded');
  }

  const beneficiaryAmount = params.covenantUtxo.value - covenantLoss;
  if (beneficiaryAmount <= 0n) {
    throw new Error('covenant-funds-empty');
  }

  const toUint8Array = (value: Buffer | string): Uint8Array =>
    typeof value === 'string' ? new Uint8Array(Buffer.from(value, 'hex')) : new Uint8Array(value);

  const beneficiarySk = toUint8Array(params.beneficiaryPrivKey!);
  const redeemScript = new EcashScript(toUint8Array(params.redeemScriptHex!));

  const covenantInput: TxBuilderInput = {
    input: {
      prevOut: { txid: params.covenantUtxo.txid, outIdx: params.covenantUtxo.vout },
      sequence: FINAL_SEQUENCE,
      signData: {
        value: Number(params.covenantUtxo.value),
        redeemScript,
      },
    },
    signatory: (eccInstance: any, input: any) => {
      const preimage = input.sigHashPreimage(SINGLE_ANYONECANPAY_BIP143);
      const preimageHash = crypto.createHash('sha256').update(preimage.bytes).digest();
      const sighash = sha256d(preimage.bytes);
      const sig = eccInstance.schnorrSign(beneficiarySk, sighash);
      const flaggedSig = flagSignature(sig, SINGLE_ANYONECANPAY_BIP143);
      const output0Hex = serializeTxOutputHex({
        value: beneficiaryAmount,
        scriptPubKey: beneficiaryScript,
      });
      const unlockingScript = EcashScript.fromOps([
        pushBytesOp(flaggedSig),
        pushBytesOp(sig),
        pushBytesOp(preimage.bytes),
        pushBytesOp(preimageHash),
        pushBytesOp(new Uint8Array(Buffer.from(output0Hex, 'hex'))),
        OP_1,
        pushBytesOp(preimage.redeemScript.bytecode),
      ]);

      console.log('[DEBUG-V1] finalize preimage hex:', Buffer.from(preimage.bytes).toString('hex'));
      console.log('[DEBUG-V1] finalize preimage sha256 hex:', Buffer.from(preimageHash).toString('hex'));
      console.log('[DEBUG-V1] finalize sighash hex:', Buffer.from(sighash).toString('hex'));
      console.log(
        '[DEBUG-V1] finalize redeemScript hex:',
        Buffer.from(preimage.redeemScript.bytecode).toString('hex'),
      );
      console.log(
        '[DEBUG-V1] finalize unlockingScript hex:',
        Buffer.from(unlockingScript.bytecode).toString('hex'),
      );

      return unlockingScript;
    },
  };

  const gasInputs: TxBuilderInput[] = [];
  if (gasUtxos.length > 0 && params.gasPrivKey) {
    const gasSk = toUint8Array(params.gasPrivKey);
    const gasPk = toUint8Array(Buffer.from(normalizePublicKey(params.gasPrivKey), 'hex'));

    for (const utxo of gasUtxos) {
      gasInputs.push({
        input: {
          prevOut: { txid: utxo.txid, outIdx: utxo.vout },
          sequence: utxo.sequence ?? FINAL_SEQUENCE,
          signData: {
            value: Number(utxo.value),
            outputScript: new EcashScript(toUint8Array(utxo.scriptPubKey)),
          },
        },
        signatory: P2PKHSignatory(gasSk, gasPk, ALL_BIP143),
      });
    }
  }

  const beneficiaryScript = await addressToScriptPubKey(params.beneficiaryAddress);
  const outputs: any[] = [
    {
      value: Number(beneficiaryAmount),
      script: new EcashScript(toUint8Array(beneficiaryScript)),
    },
  ];

  let gasChangeScript: string | undefined;
  if (gasInputs.length > 0) {
    if (!params.gasChangeAddress) {
      throw new Error('gas-change-address-required');
    }
    gasChangeScript = await addressToScriptPubKey(params.gasChangeAddress);
    outputs.push(new EcashScript(toUint8Array(gasChangeScript)));
  }

  const txBuild = new TxBuilder({
    inputs: [covenantInput, ...gasInputs],
    outputs,
  });
  const signedTx = txBuild.sign(ecc, Number(MIN_RELAY_FEE_PER_KB), 546);

  const unsignedTx: UnsignedTx = {
    inputs: signedTx.inputs.map((input, index) => ({
      ...(index === 0 ? params.covenantUtxo : gasUtxos[index - 1]!),
      sequence: input.sequence ?? FINAL_SEQUENCE,
      scriptSig: input.script?.toHex(),
    })),
    outputs: signedTx.outputs.map((output) => ({
      value: BigInt(output.value),
      scriptPubKey: output.script.toHex(),
    })),
  };
  const rawHex = Buffer.from(signedTx.ser()).toString('hex');

  console.log('[DEBUG-V1] finalize final raw tx hex before broadcast:', rawHex);

  return {
    unsignedTx,
    rawHex,
    fee: feeTarget,
  };
}

async function buildRefundTxV1(params: RefundTxParams): Promise<BuiltTx> {
  const fixedFee = params.fixedFee ?? MIN_ABSOLUTE_FEE;
  if (params.refundAmount > params.covenantUtxo.value) {
    throw new Error('refund-too-large');
  }

  const refundScript = await addressToScriptPubKey(params.refundAddress);
  const locktime = normalizeLocktime(params.expirationTime);
  const remainingAfterFee = params.covenantUtxo.value - params.refundAmount - fixedFee;
  if (remainingAfterFee < 0n) {
    throw new Error('refund-insufficient-for-fee');
  }

  const outputs: UnsignedTx['outputs'] = [{ value: params.refundAmount, scriptPubKey: refundScript }];
  if (remainingAfterFee >= 546n) {
    outputs.push({ value: remainingAfterFee, scriptPubKey: params.covenantUtxo.scriptPubKey });
  }

  const covenantInput: UnsignedTx['inputs'][number] = {
    ...params.covenantUtxo,
    sequence: NON_FINAL_SEQUENCE,
  };
  const unsignedTx: UnsignedTx = {
    inputs: [covenantInput],
    outputs,
    locktime,
  };
  const signature = signRefundInputV1(unsignedTx, params.refundOraclePrivKey!, params.redeemScriptHex!, 0);
  covenantInput.scriptSig = buildRefundUnlockingScriptV1(signature, params.redeemScriptHex!);

  return {
    unsignedTx,
    rawHex: serializeUnsignedTx(unsignedTx),
    fee: params.covenantUtxo.value - outputs.reduce((acc, output) => acc + output.value, 0n),
  };
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
    writeUInt32LE(sequences, i === gasInputIndex ? NON_FINAL_SEQUENCE : FINAL_SEQUENCE);
  }
  chunks.push(...hash256(Buffer.from(sequences)));

  const gasInput = unsignedTx.inputs[gasInputIndex];
  writeTxid(chunks, gasInput.txid);
  writeUInt32LE(chunks, gasInput.vout);

  const scriptBytes = hexToBytes(gasInput.scriptPubKey);
  writeVarInt(chunks, scriptBytes.length);
  chunks.push(...scriptBytes);

  writeUInt64LE(chunks, gasInput.value);
  writeUInt32LE(chunks, NON_FINAL_SEQUENCE);

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
    writeUInt32LE(finalTx, i === gasInputIndex ? NON_FINAL_SEQUENCE : FINAL_SEQUENCE);
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

const ZERO_HASH_BYTES = new Array(32).fill(0);

function signEcashInput(
  unsignedTx: UnsignedTx,
  privateKey: Buffer | string,
  redeemScriptHex: string,
  inputIndex: number
): string {
  const privKey = asPrivKeyBuffer(privateKey);
  const sighash = Buffer.from(
    computeEcashSigHash(unsignedTx, inputIndex, redeemScriptHex, SIGHASH_SINGLE_ANYONECANPAY_FORKID),
    'hex',
  );
  const sig64 = secp256k1.sign(sighash, privKey).toCompactRawBytes();
  return Buffer.concat([
    toDerSignature(sig64),
    Buffer.from([SIGHASH_SINGLE_ANYONECANPAY_FORKID]),
  ]).toString('hex');
}

function computeP2pkhSigHash(
  unsignedTx: UnsignedTx,
  inputIndex: number,
  coveredBytecodeHex: string,
  sighashType = SIGHASH_ALL_FORKID
): string {
  if (inputIndex < 0 || inputIndex >= unsignedTx.inputs.length) {
    throw new Error('invalid-input-index');
  }

  const baseType = sighashType & 0x1f;
  const anyoneCanPay = (sighashType & SIGHASH_ANYONECANPAY) !== 0;
  const chunks: number[] = [];

  writeUInt32LE(chunks, 2);
  chunks.push(...(anyoneCanPay ? ZERO_HASH_BYTES : hashPrevouts(unsignedTx.inputs)));
  chunks.push(...((anyoneCanPay || baseType === 0x02 || baseType === 0x03) ? ZERO_HASH_BYTES : hashSequences(unsignedTx.inputs)));

  const input = unsignedTx.inputs[inputIndex]!;
  writeTxid(chunks, input.txid);
  writeUInt32LE(chunks, input.vout);

  const coveredBytecode = hexToBytes(coveredBytecodeHex);
  writeVarInt(chunks, coveredBytecode.length);
  chunks.push(...coveredBytecode);

  writeUInt64LE(chunks, input.value);
  writeUInt32LE(chunks, input.sequence ?? FINAL_SEQUENCE);
  chunks.push(...hashOutputs(unsignedTx.outputs, inputIndex, baseType));
  writeUInt32LE(chunks, unsignedTx.locktime ?? 0);
  writeUInt32LE(chunks, sighashType);

  return hash256(Buffer.from(chunks)).toString('hex');
}

function hashPrevouts(inputs: UnsignedTx['inputs']): number[] {
  const bytes: number[] = [];
  for (const input of inputs) {
    writeTxid(bytes, input.txid);
    writeUInt32LE(bytes, input.vout);
  }
  return [...hash256(Buffer.from(bytes))];
}

function hashSequences(inputs: UnsignedTx['inputs']): number[] {
  const bytes: number[] = [];
  for (const input of inputs) {
    writeUInt32LE(bytes, input.sequence ?? FINAL_SEQUENCE);
  }
  return [...hash256(Buffer.from(bytes))];
}

function hashOutputs(outputs: UnsignedTx['outputs'], inputIndex: number, baseType: number): number[] {
  if (baseType === 0x02) {
    return ZERO_HASH_BYTES;
  }
  if (baseType === 0x03) {
    if (inputIndex >= outputs.length) {
      return ZERO_HASH_BYTES;
    }
    return serializeAndHashOutputs([outputs[inputIndex]!]);
  }
  return serializeAndHashOutputs(outputs);
}

function serializeAndHashOutputs(outputs: UnsignedTx['outputs']): number[] {
  const bytes: number[] = [];
  for (const output of outputs) {
    bytes.push(...serializeTxOutputBytes(output));
  }
  return [...hash256(Buffer.from(bytes))];
}

function serializeTxOutputHex(output: UnsignedTx['outputs'][number]): string {
  return Buffer.from(serializeTxOutputBytes(output)).toString('hex');
}

function serializeTxOutputBytes(output: UnsignedTx['outputs'][number]): number[] {
  const bytes: number[] = [];
  writeUInt64LE(bytes, output.value);
  const scriptBytes = hexToBytes(output.scriptPubKey);
  writeVarInt(bytes, scriptBytes.length);
  bytes.push(...scriptBytes);
  return bytes;
}

function asPrivKeyBuffer(privateKey: Buffer | string): Buffer {
  if (Buffer.isBuffer(privateKey)) {
    return privateKey;
  }
  return Buffer.from(privateKey, 'hex');
}

function normalizePublicKey(privateKey: Buffer | string, publicKey?: string): string {
  if (publicKey?.trim()) {
    return publicKey.trim().toLowerCase();
  }
  return Buffer.from(secp256k1.getPublicKey(asPrivKeyBuffer(privateKey), true)).toString('hex');
}

function normalizeLocktime(locktime: bigint | number | undefined): number {
  if (locktime === undefined) {
    throw new Error('refund-expiration-required');
  }
  const value = typeof locktime === 'bigint' ? locktime : BigInt(locktime);
  if (value < 0n || value > 0xffffffffn) {
    throw new Error('invalid-locktime');
  }
  return Number(value);
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
    const scriptSigBytes = input.scriptSig ? hexToBytes(input.scriptSig) : [];
    writeVarInt(chunks, scriptSigBytes.length);
    chunks.push(...scriptSigBytes);
    writeUInt32LE(chunks, input.sequence ?? FINAL_SEQUENCE);
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

function serializeScriptChunks(chunks: string[]): string {
  return chunks.join('');
}

function pushHexChunk(hex: string): string {
  const bytes = hexToBytes(hex);
  return Buffer.from([...encodePushData(bytes), ...bytes]).toString('hex');
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

function estimateTxFee(unsignedTx: UnsignedTx, feeRateSatsPerByte: bigint): bigint {
  if (feeRateSatsPerByte <= 0n) {
    throw new Error('invalid-fee-rate');
  }
  const estimatedSize = estimateUnsignedTxSize(unsignedTx);
  const relayMinFee = (estimatedSize * MIN_RELAY_FEE_PER_KB + 999n) / 1000n;
  const sizeBasedFee = estimatedSize * feeRateSatsPerByte;
  if (sizeBasedFee < MIN_ABSOLUTE_FEE) {
    return MIN_ABSOLUTE_FEE > relayMinFee ? MIN_ABSOLUTE_FEE : relayMinFee;
  }
  return sizeBasedFee > relayMinFee ? sizeBasedFee : relayMinFee;
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

function estimateUnsignedTxSize(unsignedTx: UnsignedTx): bigint {
  let size = 4n + 4n;
  size += BigInt(varIntSize(unsignedTx.inputs.length));
  for (const input of unsignedTx.inputs) {
    const scriptSigSize = input.scriptSig ? input.scriptSig.length / 2 : estimateScriptSigSize(input.scriptPubKey);
    size += 36n;
    size += BigInt(varIntSize(scriptSigSize));
    size += BigInt(scriptSigSize);
    size += 4n;
  }
  size += BigInt(varIntSize(unsignedTx.outputs.length));
  for (const output of unsignedTx.outputs) {
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
