import { secp256k1 } from '@noble/curves/secp256k1';
import { TEYOLIA_COVENANT_V1 } from '../covenants/scriptCompiler';
import type { Utxo } from '../blockchain/types';
import { validateAddress } from '../utils/validation';
import { derivePrivKeyFromSeed } from '../blockchain/txBuilder';

export type SpendableCampaignRecord = {
  id: string;
  goal: string;
  status?: string;
  activationFeePaid?: boolean;
  payout?: {
    txid?: string | null;
    paidAt?: string | null;
  };
  beneficiaryAddress?: string;
  campaignAddress?: string;
  covenantAddress?: string;
  beneficiaryPubKey?: string;
  refundOraclePubKey?: string | null;
  contractVersion?: string | null;
  redeemScriptHex?: string | null;
  scriptPubKey?: string | null;
  expirationTime?: string;
  expiresAt?: string;
};

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isV1Campaign(campaign: Pick<SpendableCampaignRecord, 'contractVersion'>): boolean {
  return trimString(campaign.contractVersion) === TEYOLIA_COVENANT_V1;
}

export function resolveCampaignEscrowAddress(campaign: SpendableCampaignRecord): string {
  const candidate = trimString(campaign.campaignAddress) || trimString(campaign.covenantAddress);
  if (!candidate) {
    throw new Error('campaign-address-required');
  }
  return validateAddress(candidate, 'campaignAddress');
}

export function resolveCampaignBeneficiaryAddress(campaign: SpendableCampaignRecord): string {
  const candidate = trimString(campaign.beneficiaryAddress);
  if (!candidate) {
    throw new Error('beneficiary-address-required');
  }
  return validateAddress(candidate, 'beneficiaryAddress');
}

export function requireV1RedeemScriptHex(campaign: SpendableCampaignRecord): string {
  const redeemScriptHex = trimString(campaign.redeemScriptHex).toLowerCase();
  if (!redeemScriptHex) {
    throw new Error('v1-redeem-script-required');
  }
  return redeemScriptHex;
}

export function requireV1BeneficiaryPubKey(campaign: SpendableCampaignRecord): string {
  const beneficiaryPubKey = trimString(campaign.beneficiaryPubKey).toLowerCase();
  if (!beneficiaryPubKey) {
    throw new Error('v1-beneficiary-pubkey-required');
  }
  return beneficiaryPubKey;
}

export function requireV1RefundOraclePubKey(campaign: SpendableCampaignRecord): string {
  const refundOraclePubKey = trimString(campaign.refundOraclePubKey).toLowerCase();
  if (!refundOraclePubKey) {
    throw new Error('v1-refund-oracle-pubkey-required');
  }
  return refundOraclePubKey;
}

export function requireV1ExpirationTime(campaign: SpendableCampaignRecord): bigint {
  const direct = trimString(campaign.expirationTime);
  if (direct) {
    return BigInt(direct);
  }
  const expiresAt = trimString(campaign.expiresAt);
  if (expiresAt) {
    const parsed = Date.parse(expiresAt);
    if (Number.isFinite(parsed)) {
      return BigInt(parsed);
    }
  }
  throw new Error('v1-expiration-time-required');
}

export function filterSpendableUtxos(utxos: Utxo[]): Utxo[] {
  return utxos.filter((utxo) => !utxo.token && !utxo.slpToken && !utxo.tokenStatus && !utxo.plugins?.token);
}

export function selectCampaignCovenantUtxo(args: {
  campaignId: string;
  utxos: Utxo[];
  scriptPubKey?: string | null;
  tracked?: {
    txid: string;
    vout: number;
  } | null;
}): Utxo {
  const normalizedScript = trimString(args.scriptPubKey).toLowerCase();
  const tracked = args.tracked;
  if (tracked?.txid) {
    const matchedTracked = args.utxos.find((utxo) => utxo.txid === tracked.txid && utxo.vout === tracked.vout);
    if (matchedTracked) {
      return matchedTracked;
    }
  }

  const sameScript = normalizedScript
    ? args.utxos.filter((utxo) => utxo.scriptPubKey.toLowerCase() === normalizedScript)
    : args.utxos;
  if (sameScript.length === 1) {
    return sameScript[0]!;
  }
  if (sameScript.length === 0) {
    throw new Error('campaign-covenant-utxo-missing');
  }
  throw new Error(`campaign-covenant-utxo-ambiguous:${args.campaignId}`);
}

export async function resolvePrivateKeyFromEnv(options: {
  privKeyEnvNames: string[];
  seedEnvNames?: string[];
  publicKeyHex?: string;
  missingError: string;
  mismatchError: string;
}): Promise<Buffer> {
  for (const envName of options.privKeyEnvNames) {
    const candidate = trimString(process.env[envName]);
    if (!candidate) {
      continue;
    }
    const privateKey = Buffer.from(candidate, 'hex');
    validateDerivedPublicKey(privateKey, options.publicKeyHex, options.mismatchError);
    return privateKey;
  }

  for (const envName of options.seedEnvNames ?? []) {
    const candidate = trimString(process.env[envName]);
    if (!candidate) {
      continue;
    }
    const privateKey = await derivePrivKeyFromSeed(candidate);
    validateDerivedPublicKey(privateKey, options.publicKeyHex, options.mismatchError);
    return privateKey;
  }

  throw new Error(options.missingError);
}

function validateDerivedPublicKey(privateKey: Buffer, expectedPublicKeyHex: string | undefined, mismatchError: string): void {
  const normalizedExpected = trimString(expectedPublicKeyHex).toLowerCase();
  if (!normalizedExpected) {
    return;
  }
  const derived = Buffer.from(secp256k1.getPublicKey(privateKey, true)).toString('hex');
  if (derived !== normalizedExpected) {
    throw new Error(mismatchError);
  }
}
