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
  goal: string;
  expirationTime: string;
  beneficiaryAddress?: string;
  progress?: number;
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
}
