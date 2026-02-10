export interface CovenantRef {
  campaignId: string;
  txid: string;
  vout: number;
  scriptHash: string;
  scriptPubKey: string;
  value: bigint;
}

/**
 * In-memory covenant reference index; replace with DB or Chronik/indexer later.
 */
export class CovenantIndex {
  private byCampaign = new Map<string, CovenantRef>();

  setCovenantRef(ref: CovenantRef): void {
    this.byCampaign.set(ref.campaignId, ref);
  }

  getCovenantRef(campaignId: string): CovenantRef | undefined {
    return this.byCampaign.get(campaignId);
  }

  updateValue(campaignId: string, newValue: bigint): void {
    const ref = this.byCampaign.get(campaignId);
    if (ref) {
      this.byCampaign.set(campaignId, { ...ref, value: newValue });
    }
  }

  deleteCampaign(campaignId: string): void {
    this.byCampaign.delete(campaignId);
  }
}
