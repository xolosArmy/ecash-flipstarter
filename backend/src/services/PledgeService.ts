import { getUtxosForAddress } from '../blockchain/ecashClient';
import { buildPledgeTx, type BuiltTx } from '../blockchain/txBuilder';
import type { Utxo } from '../blockchain/types';
import { validateAddress } from '../utils/validation';
import { CampaignService, campaignStore, covenantIndexInstance } from './CampaignService';
import { isV1Campaign, requireV1RedeemScriptHex, type SpendableCampaignRecord } from './covenantV1Integration';

const MIN_PLEDGE_FEE_SATS = 500n;

type PledgeDependencies = {
  campaignService: Pick<CampaignService, 'getCampaign'>;
  getUtxosForAddress: typeof getUtxosForAddress;
  buildPledgeTx: typeof buildPledgeTx;
};

const defaultDependencies: PledgeDependencies = {
  campaignService: new CampaignService(),
  getUtxosForAddress,
  buildPledgeTx,
};

export class PledgeService {
  constructor(private readonly deps: PledgeDependencies = defaultDependencies) {}

  /**
   * Build an unsigned pledge transaction for a contributor.
   */
  async createPledgeTx(
    campaignId: string,
    contributorAddress: string,
    amount: bigint,
  ): Promise<BuiltTx & { nextCovenantValue: bigint }> {
    const covenant = covenantIndexInstance.getCovenantRef(campaignId);
    if (!covenant) throw new Error('campaign-not-found');
    const campaign = campaignStore.get(campaignId);
    if (!campaign) throw new Error('campaign-not-found');
    const serializedCampaign = await this.deps.campaignService.getCampaign(campaignId) as SpendableCampaignRecord | null;
    if (!serializedCampaign) throw new Error('campaign-not-found');
    const campaignStatus = (campaign as unknown as { status?: string }).status;
    if (campaignStatus && campaignStatus !== 'active') {
      throw new Error('campaign-not-active');
    }
    const escrowAddress = resolveCampaignEscrowAddress(campaign);

    const contributorUtxos = await this.deps.getUtxosForAddress(contributorAddress);
    // Only spend pure XEC UTXOs; token-bearing UTXOs must be excluded.
    const nonTokenUtxos = contributorUtxos.filter((utxo) => !hasToken(utxo));
    const built = await buildWithSelectedUtxos({
      buildPledgeTx: this.deps.buildPledgeTx,
      utxos: nonTokenUtxos,
      amount,
      contributorAddress,
      covenant,
      beneficiaryAddress: escrowAddress,
      contractVersion: isV1Campaign(serializedCampaign)
        ? String(serializedCampaign.contractVersion)
        : undefined,
      redeemScriptHex: isV1Campaign(serializedCampaign)
        ? requireV1RedeemScriptHex(serializedCampaign)
        : undefined,
    });

    // Optimistic update; real deployment should update after broadcast/confirmation.
    const nextValue = covenant.value + amount;
    covenantIndexInstance.updateValue(campaignId, nextValue);
    return { ...built, nextCovenantValue: nextValue };
  }
}

async function buildWithSelectedUtxos(args: {
  buildPledgeTx: typeof buildPledgeTx;
  utxos: Utxo[];
  amount: bigint;
  contributorAddress: string;
  covenant: {
    txid: string;
    vout: number;
    value: bigint;
    scriptPubKey: string;
    scriptHash: string;
  };
  beneficiaryAddress?: string;
  contractVersion?: string;
  redeemScriptHex?: string;
}): Promise<BuiltTx> {
  const feeTarget = args.amount + MIN_PLEDGE_FEE_SATS;
  let total = 0n;
  const selected: Utxo[] = [];

  for (const utxo of args.utxos) {
    selected.push(utxo);
    total += utxo.value;
    if (total < feeTarget) {
      continue;
    }
    try {
      return await args.buildPledgeTx({
        contributorUtxos: selected,
        covenantUtxo: {
          txid: args.covenant.txid,
          vout: args.covenant.vout,
          value: args.covenant.value,
          scriptPubKey: args.covenant.scriptPubKey,
        },
        amount: args.amount,
        covenantScriptHash: args.covenant.scriptHash,
        contributorAddress: args.contributorAddress,
        beneficiaryAddress: args.beneficiaryAddress,
        campaignScriptPubKey: args.covenant.scriptPubKey,
        contractVersion: args.contractVersion,
        redeemScriptHex: args.redeemScriptHex,
      });
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'insufficient-funds') {
        continue;
      }
      throw err;
    }
  }
  throw new Error('insufficient-funds');
}

function resolveCampaignEscrowAddress(campaign: unknown): string {
  const maybeRecord = campaign as Record<string, unknown>;
  const candidates: unknown[] = [
    maybeRecord.campaignAddress,
    maybeRecord.covenantAddress,
    maybeRecord.address,
    maybeRecord.recipient,
    maybeRecord.recipientAddress,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return validateAddress(candidate.trim(), 'campaignAddress');
    }
  }
  throw new Error('campaign-address-required');
}

function hasToken(utxo: Utxo): boolean {
  return Boolean(utxo.token || utxo.slpToken || utxo.tokenStatus || utxo.plugins?.token);
}
