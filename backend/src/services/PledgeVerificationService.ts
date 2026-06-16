import { addressToScriptPubKey, getTransactionInfo, type TransactionInfo } from '../blockchain/ecashClient';
import { CampaignService } from './CampaignService';
import { getPledgeByTxid, type SimplePledge } from '../store/simplePledges';
import { validateAddress } from '../utils/validation';

export type PledgeVerificationOutcome =
  | {
      status: 'confirmed';
      txid: string;
      confirmations: number;
      expectedAmountSats: bigint;
      actualAmountSats: bigint;
      expectedCampaignScriptPubKey: string;
    }
  | {
      status: 'seen_mempool';
      txid: string;
      confirmations: 0;
      expectedAmountSats: bigint;
      actualAmountSats: bigint;
      expectedCampaignScriptPubKey: string;
    }
  | {
      status: 'broadcasted';
      txid: string;
      reason: string;
      confirmations: 0;
      expectedAmountSats: bigint;
      actualAmountSats: 0n;
      expectedCampaignScriptPubKey: string;
    }
  | {
      status: 'invalid';
      txid: string;
      reason: string;
      expectedAmountSats: bigint;
      actualAmountSats: bigint;
      confirmations: number;
      expectedCampaignScriptPubKey: string;
    };

type CampaignRecord = {
  id: string;
  campaignAddress?: string | null;
  covenantAddress?: string | null;
  scriptPubKey?: string | null;
};

type VerificationDependencies = {
  campaignService: Pick<CampaignService, 'getCampaign'>;
  getTransactionInfo: typeof getTransactionInfo;
  addressToScriptPubKey: typeof addressToScriptPubKey;
  getPledgeByTxid: typeof getPledgeByTxid;
};

const defaultDependencies: VerificationDependencies = {
  campaignService: new CampaignService(),
  getTransactionInfo,
  addressToScriptPubKey,
  getPledgeByTxid,
};

function normalizeScriptPubKey(value: string): string {
  return value.trim().toLowerCase();
}

function getCampaignTargetAddress(campaign: CampaignRecord): string {
  const candidate = campaign.campaignAddress || campaign.covenantAddress;
  if (!candidate) {
    throw new Error('campaign-address-required');
  }
  return validateAddress(candidate, 'campaignAddress');
}

async function resolveExpectedCampaignScriptPubKey(
  deps: VerificationDependencies,
  campaign: CampaignRecord,
): Promise<string> {
  if (typeof campaign.scriptPubKey === 'string' && campaign.scriptPubKey.trim()) {
    return normalizeScriptPubKey(campaign.scriptPubKey);
  }
  const campaignAddress = getCampaignTargetAddress(campaign);
  return normalizeScriptPubKey(await deps.addressToScriptPubKey(campaignAddress));
}

function getConfirmations(tx: TransactionInfo): number {
  return Math.max(
    Number.isFinite(tx.confirmations) ? Math.floor(tx.confirmations) : 0,
    tx.height >= 0 ? 1 : 0,
  );
}

export class PledgeVerificationService {
  constructor(private readonly deps: VerificationDependencies = defaultDependencies) {}

  async verifyPledgeTx(args: {
    campaignId: string;
    pledgeId: string;
    txid: string;
    expectedAmountSats: bigint;
  }): Promise<PledgeVerificationOutcome> {
    const campaign = (await this.deps.campaignService.getCampaign(args.campaignId)) as CampaignRecord | null;
    if (!campaign) {
      throw new Error('campaign-not-found');
    }

    const reusedPledge = await this.deps.getPledgeByTxid(args.txid);
    if (reusedPledge && reusedPledge.pledgeId !== args.pledgeId) {
      return {
        status: 'invalid',
        txid: args.txid,
        reason: 'txid-already-used',
        expectedAmountSats: args.expectedAmountSats,
        actualAmountSats: 0n,
        confirmations: 0,
        expectedCampaignScriptPubKey: await resolveExpectedCampaignScriptPubKey(this.deps, campaign),
      };
    }

    const expectedCampaignScriptPubKey = await resolveExpectedCampaignScriptPubKey(this.deps, campaign);

    let tx: TransactionInfo;
    try {
      tx = await this.deps.getTransactionInfo(args.txid);
    } catch {
      return {
        status: 'broadcasted',
        txid: args.txid,
        reason: 'txid-not-found',
        expectedAmountSats: args.expectedAmountSats,
        actualAmountSats: 0n,
        confirmations: 0,
        expectedCampaignScriptPubKey,
      };
    }

    const matchingOutputs = tx.outputs.filter(
      (output) => normalizeScriptPubKey(output.scriptPubKey) === expectedCampaignScriptPubKey,
    );
    if (matchingOutputs.length === 0) {
      return {
        status: 'invalid',
        txid: args.txid,
        reason: 'campaign-output-mismatch',
        expectedAmountSats: args.expectedAmountSats,
        actualAmountSats: 0n,
        confirmations: getConfirmations(tx),
        expectedCampaignScriptPubKey,
      };
    }

    const actualAmountSats = matchingOutputs.reduce((sum, output) => sum + output.valueSats, 0n);
    if (actualAmountSats < args.expectedAmountSats) {
      return {
        status: 'invalid',
        txid: args.txid,
        reason: 'pledge-amount-insufficient',
        expectedAmountSats: args.expectedAmountSats,
        actualAmountSats,
        confirmations: getConfirmations(tx),
        expectedCampaignScriptPubKey,
      };
    }

    const confirmations = getConfirmations(tx);
    if (confirmations < 1) {
      return {
        status: 'seen_mempool',
        txid: args.txid,
        confirmations: 0,
        expectedAmountSats: args.expectedAmountSats,
        actualAmountSats,
        expectedCampaignScriptPubKey,
      };
    }

    return {
      status: 'confirmed',
      txid: args.txid,
      confirmations,
      expectedAmountSats: args.expectedAmountSats,
      actualAmountSats,
      expectedCampaignScriptPubKey,
    };
  }
}
