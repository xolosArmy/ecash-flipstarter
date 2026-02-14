export interface Pledge {
  txid: string | null;
  contributorAddress: string;
  amount: number;
  timestamp: string;
  message?: string;
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
  createdAt?: string;
  beneficiaryAddress?: string;
  description?: string;
  activation?: CampaignActivation;
  activationFeeRequired?: number;
  activationFeePaid?: boolean;
  activationFeeTxid?: string | null;
  activationFeePaidAt?: string | null;
  payout?: CampaignPayout;
  treasuryAddressUsed?: string | null;
  totalPledged: number;
  pledgeCount: number;
  status: 'draft' | 'pending_fee' | 'expired' | 'funded' | 'active' | 'paid_out';
  location?: CampaignLocation | string;
}

export interface CampaignLocation {
  latitude: number;
  longitude: number;
}

export interface CampaignActivation {
  feeSats: string;
  wcOfferId?: string | null;
  feeTxid?: string | null;
  feePaidAt?: string | null;
  payerAddress?: string | null;
}

export interface CampaignPayout {
  wcOfferId?: string | null;
  txid?: string | null;
  paidAt?: string | null;
}
