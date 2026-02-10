export type SimplePledge = {
  pledgeId: string;
  txid: string | null;
  amount: number;
  contributorAddress: string;
  timestamp: string;
  message?: string;
};

export const simplePledges = new Map<string, SimplePledge[]>();
