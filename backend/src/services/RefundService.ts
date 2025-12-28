import { buildRefundTx, type BuiltTx } from '../blockchain/txBuilder';
import { covenantIndexInstance } from './CampaignService';

export class RefundService {
  /**
   * Build an unsigned refund transaction draining part of the covenant to refundAddress.
   */
  async createRefundTx(campaignId: string, refundAddress: string, refundAmount: bigint): Promise<BuiltTx> {
    const covenant = covenantIndexInstance.getCovenantRef(campaignId);
    if (!covenant) throw new Error('campaign-not-found');

    const built = await buildRefundTx({
      covenantUtxo: {
        txid: covenant.txid,
        vout: covenant.vout,
        value: covenant.value,
        scriptPubKey: covenant.scriptPubKey,
      },
      refundAddress,
      refundAmount,
    });

    covenantIndexInstance.updateValue(campaignId, covenant.value - refundAmount);
    return built;
  }
}
