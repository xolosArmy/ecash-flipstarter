export interface CovenantRef {
  txid: string;
  vout: number;
  value: string;
  scriptHash: string;
  scriptPubKey: string;
}

export interface CampaignSummary {
  id: string;
  name: string;
  goal: number;
  expiresAt: string;
  createdAt?: string;
  status?: 'draft' | 'pending_fee' | 'expired' | 'funded' | 'active' | 'paid_out';
  beneficiaryAddress?: string;
  description?: string;
  location?: string;
  activation?: {
    feeSats: string;
    feeTxid?: string | null;
    feePaidAt?: string | null;
    payerAddress?: string | null;
    wcOfferId?: string | null;
  };
  payout?: {
    wcOfferId?: string | null;
    txid?: string | null;
    paidAt?: string | null;
  };
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
  wcOfferId?: string;
  offerId?: string;
  pledgeId?: string;
  amount?: string;
  contributorAddress?: string;
  campaignId?: string;
  expiresAt?: number;
}
