import { createHash } from 'crypto';
import type { CampaignDefinition } from './campaignDefinition';

export const TEYOLIA_COVENANT_V1 = 'teyolia-covenant-v1' as const;
export const LEGACY_PLACEHOLDER_COVENANT = 'legacy-placeholder' as const;

export const OP = {
  OP_0: 0x00,
  OP_FALSE: 0x00,
  OP_PUSHDATA1: 0x4c,
  OP_PUSHDATA2: 0x4d,
  OP_PUSHDATA4: 0x4e,
  OP_1NEGATE: 0x4f,
  OP_RESERVED: 0x50,
  OP_1: 0x51,
  OP_2: 0x52,
  OP_3: 0x53,
  OP_16: 0x60,
  OP_IF: 0x63,
  OP_ELSE: 0x67,
  OP_ENDIF: 0x68,
  OP_VERIFY: 0x69,
  OP_DROP: 0x75,
  OP_DUP: 0x76,
  OP_EQUAL: 0x87,
  OP_EQUALVERIFY: 0x88,
  OP_SUB: 0x94,
  OP_NUMEQUAL: 0x9c,
  OP_NUMEQUALVERIFY: 0x9d,
  OP_LESSTHANOREQUAL: 0xa1,
  OP_GREATERTHAN: 0xa0,
  OP_GREATERTHANOREQUAL: 0xa2,
  OP_HASH160: 0xa9,
  OP_CHECKSIG: 0xac,
  OP_CHECKSIGVERIFY: 0xad,
  OP_CHECKLOCKTIMEVERIFY: 0xb1,
  OP_INPUTINDEX: 0xc0,
  OP_ACTIVEBYTECODE: 0xc1,
  OP_TXVERSION: 0xc2,
  OP_TXINPUTCOUNT: 0xc3,
  OP_TXOUTPUTCOUNT: 0xc4,
  OP_TXLOCKTIME: 0xc5,
  OP_UTXOVALUE: 0xc6,
  OP_UTXOBYTECODE: 0xc7,
  OP_OUTPUTVALUE: 0xcc,
  OP_OUTPUTBYTECODE: 0xcd,
} as const;

export interface CampaignCovenantParams {
  goal: bigint | number | string;
  expirationTime: bigint | number | string;
  beneficiaryPubKey: string;
  refundOraclePubKey: string;
  feeCapSats?: bigint | number | string;
}

export interface CompiledCampaignScript {
  contractVersion: typeof TEYOLIA_COVENANT_V1 | typeof LEGACY_PLACEHOLDER_COVENANT;
  scriptHex: string;
  scriptHash: string;
  redeemScriptHex?: string;
  scriptPubKeyHex?: string;
  scriptHashHex?: string;
  beneficiaryLockingBytecodeHex?: string;
  constructorArgs?: Record<string, string>;
}

type ScriptChunk = number | Uint8Array | number[];

export function hexToBytes(hex: string): Uint8Array {
  const normalized = normalizeHex(hex);
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array | number[]): string {
  return Buffer.from(bytes).toString('hex');
}

export function pushBytes(bytes: Uint8Array | number[]): number[] {
  const data = Array.from(bytes);
  if (data.length <= 0x4b) {
    return [data.length, ...data];
  }
  if (data.length <= 0xff) {
    return [OP.OP_PUSHDATA1, data.length, ...data];
  }
  if (data.length <= 0xffff) {
    return [OP.OP_PUSHDATA2, data.length & 0xff, (data.length >> 8) & 0xff, ...data];
  }
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length, 0);
  return [OP.OP_PUSHDATA4, ...length, ...data];
}

export function encodeScriptNum(value: bigint | number | string): Uint8Array {
  let remaining = toBigInt(value);
  if (remaining === 0n) {
    return new Uint8Array();
  }

  const negative = remaining < 0n;
  if (negative) {
    remaining = -remaining;
  }

  const result: number[] = [];
  while (remaining > 0n) {
    result.push(Number(remaining & 0xffn));
    remaining >>= 8n;
  }

  const signBitSet = (result[result.length - 1] & 0x80) !== 0;
  if (signBitSet) {
    result.push(negative ? 0x80 : 0x00);
  } else if (negative) {
    result[result.length - 1] |= 0x80;
  }

  return Uint8Array.from(result);
}

export function pushScriptNum(value: bigint | number | string): number[] {
  const numeric = toBigInt(value);
  if (numeric === 0n) return [OP.OP_0];
  if (numeric === -1n) return [OP.OP_1NEGATE];
  if (numeric >= 1n && numeric <= 16n) {
    return [Number(OP.OP_1) + Number(numeric - 1n)];
  }
  return pushBytes(encodeScriptNum(numeric));
}

export function hash160(bytes: Uint8Array | number[]): Uint8Array {
  const sha256 = createHash('sha256').update(Buffer.from(bytes)).digest();
  return new Uint8Array(createHash('ripemd160').update(sha256).digest());
}

export function p2pkhLockingBytecodeFromPubKeyHash(pubKeyHash: Uint8Array | number[]): string {
  const hashBytes = Uint8Array.from(pubKeyHash);
  if (hashBytes.length !== 20) {
    throw new Error(`expected-pubkey-hash-20-bytes:${hashBytes.length}`);
  }
  return bytesToHex([
    OP.OP_DUP,
    OP.OP_HASH160,
    ...pushBytes(hashBytes),
    OP.OP_EQUALVERIFY,
    OP.OP_CHECKSIG,
  ]);
}

export function p2shLockingBytecodeFromRedeemScript(redeemScript: Uint8Array | number[]): {
  scriptHashHex: string;
  scriptPubKeyHex: string;
} {
  const scriptHashBytes = hash160(redeemScript);
  return {
    scriptHashHex: bytesToHex(scriptHashBytes),
    scriptPubKeyHex: bytesToHex([OP.OP_HASH160, ...pushBytes(scriptHashBytes), OP.OP_EQUAL]),
  };
}

export function compileCampaignCovenantV1(
  params: CampaignCovenantParams,
): {
  redeemScriptHex: string;
  scriptPubKeyHex: string;
  scriptHashHex: string;
  beneficiaryLockingBytecodeHex: string;
} {
  const goal = toBigInt(params.goal);
  const expirationTime = toBigInt(params.expirationTime);
  const feeCapSats = toBigInt(params.feeCapSats ?? 1000n);
  if (goal < 0n) throw new Error('campaign-goal-negative');
  if (expirationTime < 0n) throw new Error('campaign-expiration-negative');
  if (feeCapSats < 0n) throw new Error('campaign-fee-cap-negative');

  const beneficiaryPubKey = expectHexBytes(params.beneficiaryPubKey, [33, 65], 'beneficiaryPubKey');
  const refundOraclePubKey = expectHexBytes(params.refundOraclePubKey, [33, 65], 'refundOraclePubKey');
  const beneficiaryLockingBytecodeHex = p2pkhLockingBytecodeFromPubKeyHash(hash160(beneficiaryPubKey));
  const beneficiaryLockingBytecode = hexToBytes(beneficiaryLockingBytecodeHex);

  // Unlocking shape for the next step:
  // pledge   -> <0x03>
  // finalize -> <beneficiary_sig> <beneficiary_pubkey> <0x01>
  // refund   -> <oracle_sig> <0x02>
  const finalizeBranch = compileScript(
    OP.OP_DROP,
    pushBytes(beneficiaryPubKey),
    OP.OP_EQUALVERIFY,
    pushBytes(beneficiaryPubKey),
    OP.OP_CHECKSIGVERIFY,
    OP.OP_INPUTINDEX,
    OP.OP_UTXOVALUE,
    pushScriptNum(goal),
    OP.OP_GREATERTHANOREQUAL,
    OP.OP_VERIFY,
    pushScriptNum(0n),
    OP.OP_OUTPUTBYTECODE,
    pushBytes(beneficiaryLockingBytecode),
    OP.OP_EQUALVERIFY,
    OP.OP_INPUTINDEX,
    OP.OP_UTXOVALUE,
    pushScriptNum(feeCapSats),
    OP.OP_SUB,
    pushScriptNum(0n),
    OP.OP_OUTPUTVALUE,
    OP.OP_LESSTHANOREQUAL,
    OP.OP_VERIFY,
    OP.OP_1,
  );

  const refundBranch = compileScript(
    OP.OP_DROP,
    pushScriptNum(expirationTime),
    OP.OP_CHECKLOCKTIMEVERIFY,
    OP.OP_DROP,
    pushBytes(refundOraclePubKey),
    OP.OP_CHECKSIGVERIFY,
    OP.OP_TXOUTPUTCOUNT,
    pushScriptNum(1n),
    OP.OP_GREATERTHAN,
    OP.OP_IF,
    pushScriptNum(1n),
    OP.OP_OUTPUTBYTECODE,
    OP.OP_INPUTINDEX,
    OP.OP_UTXOBYTECODE,
    OP.OP_EQUALVERIFY,
    OP.OP_ENDIF,
    OP.OP_1,
  );

  const pledgeBranch = compileScript(
    pushScriptNum(0n),
    OP.OP_OUTPUTBYTECODE,
    OP.OP_INPUTINDEX,
    OP.OP_UTXOBYTECODE,
    OP.OP_EQUALVERIFY,
    pushScriptNum(0n),
    OP.OP_OUTPUTVALUE,
    OP.OP_INPUTINDEX,
    OP.OP_UTXOVALUE,
    OP.OP_GREATERTHAN,
    OP.OP_VERIFY,
    OP.OP_1,
  );

  const redeemScript = compileScript(
    OP.OP_DUP,
    pushScriptNum(1n),
    OP.OP_NUMEQUAL,
    OP.OP_IF,
    finalizeBranch,
    OP.OP_ELSE,
    OP.OP_DUP,
    pushScriptNum(2n),
    OP.OP_NUMEQUAL,
    OP.OP_IF,
    refundBranch,
    OP.OP_ELSE,
    pushScriptNum(3n),
    OP.OP_NUMEQUALVERIFY,
    pledgeBranch,
    OP.OP_ENDIF,
    OP.OP_ENDIF,
  );

  const redeemScriptHex = bytesToHex(redeemScript);
  const p2sh = p2shLockingBytecodeFromRedeemScript(redeemScript);
  return {
    redeemScriptHex,
    scriptPubKeyHex: p2sh.scriptPubKeyHex,
    scriptHashHex: p2sh.scriptHashHex,
    beneficiaryLockingBytecodeHex,
  };
}

export function compileCampaignScript(campaign: CampaignDefinition): CompiledCampaignScript {
  const params = getCampaignCovenantParams(campaign);
  if (params) {
    const compiled = compileCampaignCovenantV1(params);
    return {
      contractVersion: TEYOLIA_COVENANT_V1,
      scriptHex: compiled.scriptPubKeyHex,
      scriptHash: compiled.scriptHashHex,
      redeemScriptHex: compiled.redeemScriptHex,
      scriptPubKeyHex: compiled.scriptPubKeyHex,
      scriptHashHex: compiled.scriptHashHex,
      beneficiaryLockingBytecodeHex: compiled.beneficiaryLockingBytecodeHex,
      constructorArgs: {
        goal: toBigInt(params.goal).toString(),
        expirationTime: toBigInt(params.expirationTime).toString(),
        beneficiaryPubKey: normalizeHex(params.beneficiaryPubKey),
        refundOraclePubKey: normalizeHex(params.refundOraclePubKey),
        feeCapSats: toBigInt(params.feeCapSats ?? 1000n).toString(),
      },
    };
  }

  const legacy = compileLegacyPlaceholder(campaign);
  return {
    contractVersion: LEGACY_PLACEHOLDER_COVENANT,
    scriptHex: legacy.scriptHex,
    scriptHash: legacy.scriptHash,
  };
}

function getCampaignCovenantParams(campaign: CampaignDefinition): CampaignCovenantParams | null {
  const forcedLegacy = campaign.contractVersion === LEGACY_PLACEHOLDER_COVENANT;
  if (forcedLegacy) {
    return null;
  }

  const constructorArgs = campaign.constructorArgs ?? {};
  const beneficiaryPubKey = String(constructorArgs.beneficiaryPubKey ?? campaign.beneficiaryPubKey ?? '').trim();
  const refundOraclePubKey = String(
    constructorArgs.refundOraclePubKey
      ?? campaign.refundOraclePubKey
      ?? process.env.TEYOLIA_REFUND_ORACLE_PUBKEY
      ?? process.env.REFUND_ORACLE_PUBKEY
      ?? '',
  ).trim();

  if (!isHexLength(beneficiaryPubKey, [33, 65]) || !isHexLength(refundOraclePubKey, [33, 65])) {
    return null;
  }

  return {
    goal: constructorArgs.goal ?? campaign.goal,
    expirationTime: constructorArgs.expirationTime ?? campaign.expirationTime,
    beneficiaryPubKey,
    refundOraclePubKey,
    feeCapSats: constructorArgs.feeCapSats ?? 1000n,
  };
}

function compileLegacyPlaceholder(campaign: CampaignDefinition): {
  scriptHex: string;
  scriptHash: string;
} {
  const seed = [
    campaign.id,
    campaign.name ?? '',
    campaign.goal?.toString?.() ?? '',
    campaign.expirationTime?.toString?.() ?? '',
    campaign.beneficiaryPubKey ?? '',
    campaign.beneficiaryAddress ?? '',
  ].join('|');

  const seedHash = createHash('sha256').update(seed).digest();
  const redeemScript = Buffer.concat([Buffer.from([OP.OP_1, 0x20]), seedHash]);
  const scriptHash = bytesToHex(hash160(redeemScript));
  const scriptHex = `a914${scriptHash}87`;
  return { scriptHex, scriptHash };
}

function compileScript(...chunks: ScriptChunk[]): number[] {
  const script: number[] = [];
  for (const chunk of chunks) {
    if (typeof chunk === 'number') {
      script.push(chunk);
      continue;
    }
    script.push(...Array.from(chunk));
  }
  return script;
}

function toBigInt(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid-numeric-value');
    return BigInt(Math.trunc(value));
  }
  const normalized = String(value).trim();
  if (!normalized) throw new Error('invalid-empty-numeric-value');
  return BigInt(normalized);
}

function normalizeHex(hex: string): string {
  const normalized = hex.trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]*$/i.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`invalid-hex:${hex}`);
  }
  return normalized;
}

function expectHexBytes(hex: string, expectedByteLengths: number[], fieldName: string): Uint8Array {
  if (!isHexLength(hex, expectedByteLengths)) {
    throw new Error(`invalid-${fieldName}-hex`);
  }
  return hexToBytes(hex);
}

function isHexLength(hex: string, expectedByteLengths: number[]): boolean {
  try {
    const normalized = normalizeHex(hex);
    return expectedByteLengths.includes(normalized.length / 2);
  } catch {
    return false;
  }
}
