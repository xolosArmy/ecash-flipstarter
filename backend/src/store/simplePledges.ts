export type SimplePledge = {
  pledgeId: string;
  txid: string | null;
  amount: number;
  contributorAddress: string;
  timestamp: string;
};

export const simplePledges = new Map<string, SimplePledge[]>();
