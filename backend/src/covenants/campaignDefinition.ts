import cashaddr from 'ecashaddrjs';
import { type CovenantRef } from '../blockchain/covenantIndex';
import { validateAddress } from '../utils/validation';
import { compileCampaignScript } from './scriptCompiler';

export interface CampaignDefinition {
  id: string;
  name: string;
  description: string;
  goal: bigint;
  expirationTime: bigint;
  beneficiaryPubKey: string;
  beneficiaryAddress?: string;
  campaignAddress?: string;
  covenantAddress?: string;
  status?:
    | 'draft'
    | 'created'
    | 'pending_fee'
    | 'pending_verification'
    | 'fee_invalid'
    | 'active'
    | 'expired'
    | 'funded'
    | 'paid_out';
}

export type CampaignCovenantRecord = {
  campaignId: string;
  scriptPubKey: string;
  scriptHash: string;
  campaignAddress: string;
  txid?: string;
  vout?: number;
  value?: string | number | bigint;
};

function isHex(value: unknown, expectedBytes: number): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${expectedBytes * 2}}$`, 'i').test(value);
}

function isPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return !normalized
    || normalized === '51'
    || normalized === 'hash-placeholder'
    || normalized.includes('placeholder');
}

export function hasValidCampaignCovenant(record: Partial<CampaignCovenantRecord> | undefined | null): boolean {
  if (!record) return false;
  if (!isHex(record.scriptHash, 20)) return false;
  if (!isHex(record.scriptPubKey, 23) || !record.scriptPubKey.toLowerCase().startsWith('a914')) return false;
  if (isPlaceholder(record.scriptHash) || isPlaceholder(record.scriptPubKey)) return false;
  if (typeof record.campaignAddress !== 'string' || !record.campaignAddress.trim()) return false;
  try {
    const normalized = validateAddress(record.campaignAddress, 'campaignAddress');
    return !isPlaceholder(normalized);
  } catch {
    return false;
  }
}

export function ensureCampaignCovenant(args: {
  campaignId: string;
  campaign: CampaignDefinition;
  existing?: Partial<CampaignCovenantRecord & CovenantRef> | null;
}): CampaignCovenantRecord {
  const script = compileCampaignScript(args.campaign);
  const campaignAddress = validateAddress(cashaddr.encodeOutputScript(script.scriptHex, 'ecash'), 'campaignAddress');
  const existing = args.existing ?? undefined;
  return {
    campaignId: args.campaignId,
    scriptPubKey: script.scriptHex,
    scriptHash: script.scriptHash,
    campaignAddress,
    txid: typeof existing?.txid === 'string' ? existing.txid : undefined,
    vout: typeof existing?.vout === 'number' ? existing.vout : undefined,
    value: typeof existing?.value === 'bigint'
      || typeof existing?.value === 'number'
      || typeof existing?.value === 'string'
      ? existing.value
      : undefined,
  };
}
