import { getUtxosForAddress } from '../blockchain/ecashClient';
import { buildPledgeTx, type BuiltTx } from '../blockchain/txBuilder';
import type { Utxo } from '../blockchain/types';
import { covenantIndexInstance } from './CampaignService';

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

    const contributorUtxos = await getUtxosForAddress(contributorAddress);
    const selected = selectUtxos(contributorUtxos, amount);

    const built = await buildPledgeTx({
      contributorUtxos: selected,
      covenantUtxo: {
        txid: covenant.txid,
        vout: covenant.vout,
        value: covenant.value,
        scriptPubKey: covenant.scriptPubKey,
      },
      amount,
      covenantScriptHash: covenant.scriptHash,
      contributorAddress,
    });

    // Optimistic update; real deployment should update after broadcast/confirmation.
    const nextValue = covenant.value + amount;
    covenantIndexInstance.updateValue(campaignId, nextValue);
    return { ...built, nextCovenantValue: nextValue };
  }
}

function selectUtxos(utxos: Utxo[], target: bigint): Utxo[] {
  let total = 0n;
  const selected: Utxo[] = [];
  for (const utxo of utxos) {
    selected.push(utxo);
    total += utxo.value;
    if (total >= target) break;
  }
  if (total < target) throw new Error('insufficient-funds');
  return selected;
}
