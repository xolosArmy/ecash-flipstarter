import { CampaignDefinition } from '../covenants/campaignDefinition';
import { CovenantIndex, type CovenantRef } from '../blockchain/covenantIndex';
import { compileCampaignScript } from '../covenants/scriptCompiler';


const campaigns = new Map<string, CampaignDefinition>();
const covenantIndex = new CovenantIndex();

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

export { campaigns as campaignStore, covenantIndex as covenantIndexInstance };
