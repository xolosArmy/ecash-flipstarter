import { buildFinalizeTx, type BuiltTx } from '../blockchain/txBuilder';
import { covenantIndexInstance } from './CampaignService';

export class FinalizeService {
  /** Build an unsigned finalize transaction paying the beneficiary. */
  async createFinalizeTx(campaignId: string, beneficiaryAddress: string): Promise<BuiltTx> {
    const covenant = covenantIndexInstance.getCovenantRef(campaignId);
    if (!covenant) throw new Error('campaign-not-found');

    const built = await buildFinalizeTx({
      covenantUtxo: {
        txid: covenant.txid,
        vout: covenant.vout,
        value: covenant.value,
        scriptPubKey: covenant.scriptPubKey,
      },
      beneficiaryAddress,
    });

    // Covenant should terminate after finalize; value becomes zero locally.
    covenantIndexInstance.updateValue(campaignId, 0n);
    return built;
  }
}
