import { CampaignDefinition } from '../covenants/campaignDefinition';
import { CovenantIndex, type CovenantRef } from '../blockchain/covenantIndex';
import { compileCampaignScript } from '../covenants/scriptCompiler';
import { validateAddress } from '../utils/validation';


const campaigns = new Map<string, CampaignDefinition>();
const covenantIndex = new CovenantIndex();

export type DiskCampaignRecord = {
  id: string;
  name: string;
  description?: string;
  recipientAddress?: string;
  beneficiaryAddress?: string;
  campaignAddress?: string;
  covenantAddress?: string;
  address?: string;
  recipient?: string;
  goal: number;
  expiresAt: string;
  status?: 'draft' | 'pending_fee' | 'active' | 'expired' | 'funded' | 'paid_out';
};

export class CampaignService {
  /**
   * Create a new campaign and seed its covenant reference.
   */
  async createCampaign(payload: Partial<CampaignDefinition>) {
    const id = payload.id || `campaign-${Date.now()}`;
    const campaign: CampaignDefinition = {
      id,
      name: payload.name || 'Unnamed',
      description: payload.description || '',
      goal: payload.goal !== undefined ? BigInt(payload.goal) : 0n,
      expirationTime: payload.expirationTime !== undefined ? BigInt(payload.expirationTime) : 0n,
      beneficiaryPubKey: payload.beneficiaryPubKey || '',
      beneficiaryAddress: payload.beneficiaryAddress,
      campaignAddress: payload.campaignAddress,
      covenantAddress: payload.covenantAddress,
      status: payload.status,
    };
    campaigns.set(id, campaign);
    const script = compileCampaignScript(campaign);

    // Seed covenant reference with placeholder UTXO; real deployment must set this from funding tx.
    const covenantRef: CovenantRef = {
      campaignId: id,
      txid: '',
      vout: 0,
      scriptHash: script.scriptHash,
      scriptPubKey: script.scriptHex,
      value: 0n,
    };
    covenantIndex.setCovenantRef(covenantRef);
    return this.serializeCampaign(campaign, covenantRef, 0);
  }

  /**
   * Retrieve campaign metadata and current covenant ref.
   */
  async getCampaign(id: string) {
    const campaign = campaigns.get(id);
    if (!campaign) return null;
    const covenant = covenantIndex.getCovenantRef(id);
    const progress =
      covenant && campaign.goal > 0n ? Number((covenant.value * 100n) / campaign.goal) : 0;
    return this.serializeCampaign(campaign, covenant, progress);
  }

  getIndex() {
    return covenantIndex;
  }

  listCampaigns() {
    return Array.from(campaigns.values()).map((c) => {
      const covenant = covenantIndex.getCovenantRef(c.id);
      const progress =
        covenant && c.goal > 0n ? Number((covenant.value * 100n) / c.goal) : 0;
      return this.serializeCampaign(c, covenant, progress);
    });
  }

  private serializeCampaign(c: CampaignDefinition, covenant?: CovenantRef, progress?: number) {
    return {
      ...c,
      goal: c.goal.toString(),
      expirationTime: c.expirationTime.toString(),
      covenant: covenant
        ? {
            ...covenant,
            value: covenant.value.toString(),
          }
        : undefined,
      progress,
    };
  }
}

function parseExpirationTime(expiresAt: string): bigint {
  const ts = Date.parse(expiresAt);
  if (!Number.isFinite(ts) || ts <= 0) return 0n;
  return BigInt(ts);
}

function parseGoal(goal: number): bigint {
  if (!Number.isFinite(goal) || goal <= 0) return 0n;
  return BigInt(Math.trunc(goal));
}

/**
 * Keep the covenant campaign store in sync with backend/data/campaigns.json records.
 */
export function syncCampaignStoreFromDiskCampaigns(records: DiskCampaignRecord[]): void {
  const nextIds = new Set(records.map((record) => record.id));
  for (const existingId of campaigns.keys()) {
    if (!nextIds.has(existingId)) {
      campaigns.delete(existingId);
      covenantIndex.deleteCampaign(existingId);
    }
  }

  for (const record of records) {
    if (!record?.id || typeof record.id !== 'string') {
      continue;
    }

    let beneficiaryAddress: string;
    try {
      const beneficiaryCandidate =
        record.beneficiaryAddress ||
        record.address ||
        record.recipient ||
        record.recipientAddress;
      if (typeof beneficiaryCandidate !== 'string' || !beneficiaryCandidate.trim()) {
        throw new Error('recipientAddress-required');
      }
      beneficiaryAddress = validateAddress(beneficiaryCandidate, 'recipientAddress');
    } catch (err) {
      console.warn(
        `[campaigns] skipped invalid beneficiary address for ${record.id}: ${(err as Error).message}`,
      );
      continue;
    }

    const campaign: CampaignDefinition = {
      id: record.id,
      name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'Unnamed',
      description: typeof record.description === 'string' ? record.description : '',
      goal: parseGoal(record.goal),
      expirationTime: parseExpirationTime(record.expiresAt),
      beneficiaryPubKey: '',
      beneficiaryAddress,
      campaignAddress:
        typeof record.campaignAddress === 'string' && record.campaignAddress.trim()
          ? record.campaignAddress.trim()
          : undefined,
      covenantAddress:
        typeof record.covenantAddress === 'string' && record.covenantAddress.trim()
          ? record.covenantAddress.trim()
          : undefined,
      status: record.status,
    };

    campaigns.set(record.id, campaign);
    if (!covenantIndex.getCovenantRef(record.id)) {
      const script = compileCampaignScript(campaign);
      const covenantRef: CovenantRef = {
        campaignId: record.id,
        txid: '',
        vout: 0,
        scriptHash: script.scriptHash,
        scriptPubKey: script.scriptHex,
        value: 0n,
      };
      covenantIndex.setCovenantRef(covenantRef);
    }
  }
}

export { campaigns as campaignStore, covenantIndex as covenantIndexInstance };
