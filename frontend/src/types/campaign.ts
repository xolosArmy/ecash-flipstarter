export interface Pledge {
  txid: string | null;
  contributorAddress: string;
  amount: number;
  timestamp: string;
}

export interface CampaignPledgeSummary {
  totalPledged: number;
  pledgeCount: number;
  pledges: Pledge[];
}

export interface CampaignSummary {
  id: string;
  name: string;
  goal: number;
  expiresAt: string;
  totalPledged: number;
  pledgeCount: number;
  status: 'expired' | 'funded' | 'active';
  location?: CampaignLocation;
}

export interface CampaignLocation {
  latitude: number;
  longitude: number;
}
