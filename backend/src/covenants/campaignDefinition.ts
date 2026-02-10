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
  status?: 'draft' | 'pending_fee' | 'active' | 'expired' | 'funded' | 'paid_out';
}
