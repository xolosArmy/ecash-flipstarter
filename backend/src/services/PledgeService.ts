import { getUtxosForAddress } from '../blockchain/ecashClient';
import { buildPledgeTx, type BuiltTx } from '../blockchain/txBuilder';
import type { Utxo } from '../blockchain/types';
import { campaignStore, covenantIndexInstance } from './CampaignService';
import { resolveEscrowAddress } from './escrowAddress';

const MIN_PLEDGE_FEE_SATS = 500n;

export class PledgeService {
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
    const campaignStatus = (campaign as unknown as { status?: string }).status;
    if (campaignStatus && campaignStatus !== 'active') {
      throw new Error('campaign-not-active');
    }
    const escrowAddress = resolveEscrowAddress(campaign as unknown as Record<string, unknown>);

    const contributorUtxos = await getUtxosForAddress(contributorAddress);
    // Only spend pure XEC UTXOs; token-bearing UTXOs must be excluded.
    const nonTokenUtxos = contributorUtxos.filter((utxo) => !hasToken(utxo));
    const built = await buildWithSelectedUtxos({
      utxos: nonTokenUtxos,
      amount,
      contributorAddress,
      covenant,
      beneficiaryAddress: escrowAddress,
    });

    // Optimistic update; real deployment should update after broadcast/confirmation.
    const nextValue = covenant.value + amount;
    covenantIndexInstance.updateValue(campaignId, nextValue);
    return { ...built, nextCovenantValue: nextValue };
  }
}

async function buildWithSelectedUtxos(args: {
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
      return await buildPledgeTx({
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

function hasToken(utxo: Utxo): boolean {
  return Boolean(utxo.token || utxo.slpToken || utxo.tokenStatus || utxo.plugins?.token);
}
