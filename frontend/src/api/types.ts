export interface CovenantRef {
  txid: string;
  vout: number;
  value: string;
  scriptHash: string;
  scriptPubKey: string;
  campaignAddress?: string;
}

export interface CampaignSummary {
  id: string;
  slug?: string;
  canonicalId?: string;
  name: string;
  goal: number;
  expiresAt: string;
  createdAt?: string;
  status?:
    | 'draft'
    | 'created'
    | 'pending_fee'
    | 'pending_verification'
    | 'fee_invalid'
    | 'expired'
    | 'funded'
    | 'active'
    | 'paid_out';
  beneficiaryAddress?: string;
  campaignAddress?: string;
  covenantAddress?: string;
  escrowAddress?: string;
  description?: string;
  location?: string;
  activation?: {
    feeSats: string;
    feeTxid?: string | null;
    feePaidAt?: string | null;
    payerAddress?: string | null;
    wcOfferId?: string | null;
  };
  activationFeeRequired?: number;
  activationFeePaid?: boolean;
  activationFeeTxid?: string | null;
  activationFeePaidAt?: string | null;
  activationFeeVerificationStatus?: 'none' | 'pending_verification' | 'verified' | 'invalid';
  activationFeeVerifiedAt?: string | null;
  activationOfferMode?: 'tx' | 'intent' | null;
  activationOfferOutputs?: Array<{ address: string; valueSats: number }> | null;
  activationTreasuryAddressUsed?: string | null;
  payout?: {
    wcOfferId?: string | null;
    txid?: string | null;
    paidAt?: string | null;
  };
  treasuryAddressUsed?: string | null;
}

export interface CampaignDetail extends CampaignSummary {
  description: string;
  beneficiaryPubKey?: string;
  covenant?: CovenantRef;
}

export interface UnsignedTxIO {
  txid: string;
  vout: number;
  value: string;
  scriptPubKey: string;
}

export interface UnsignedTx {
  inputs: UnsignedTxIO[];
  outputs: { value: string; scriptPubKey: string }[];
  locktime?: number;
}

export interface BuiltTxResponse {
  unsignedTx: UnsignedTx;
  rawHex?: string;
  unsignedTxHex?: string;
  nextCovenantValue?: string;
  fee?: string;
  mode?: 'tx' | 'intent';
  outputs?: Array<{ address: string; valueSats: number }>;
  escrowAddress?: string;
  userPrompt?: string;
  wcOfferId?: string;
  offerId?: string;
  pledgeId?: string;
  amount?: string;
  contributorAddress?: string;
  campaignId?: string;
  expiresAt?: number;
}

export interface GlobalStats {
  totalCampaigns: number;
  totalGoalSats: number;
  totalRaisedSats: number;
  totalPledges: number;
}

export interface AuditLog {
  event: string;
  details: any;
  timestamp: string;
}
