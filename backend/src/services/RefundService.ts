import { buildRefundTx, type BuiltTx } from '../blockchain/txBuilder';
import { broadcastRawTx, getUtxosForAddress } from '../blockchain/ecashClient';
import type { Utxo } from '../blockchain/types';
import { CampaignService, covenantIndexInstance } from './CampaignService';
import {
  filterSpendableUtxos,
  isV1Campaign,
  requireV1ExpirationTime,
  requireV1RedeemScriptHex,
  requireV1RefundOraclePubKey,
  resolveCampaignEscrowAddress,
  resolvePrivateKeyFromEnv,
  selectCampaignCovenantUtxo,
  type SpendableCampaignRecord,
} from './covenantV1Integration';

type RefundDependencies = {
  campaignService: Pick<CampaignService, 'getCampaign'>;
  getUtxosForAddress: typeof getUtxosForAddress;
  buildRefundTx: typeof buildRefundTx;
  broadcastRawTx: typeof broadcastRawTx;
};

const defaultDependencies: RefundDependencies = {
  campaignService: new CampaignService(),
  getUtxosForAddress,
  buildRefundTx,
  broadcastRawTx,
};

export type BroadcastRefundResult = {
  txid: string;
  builtTx: BuiltTx;
};

export class RefundService {
  constructor(private readonly deps: RefundDependencies = defaultDependencies) {}

  async refundCampaign(campaignId: string, refundAddress: string, refundAmount: bigint): Promise<BroadcastRefundResult> {
    const campaign = await this.deps.campaignService.getCampaign(campaignId) as SpendableCampaignRecord | null;
    if (!campaign) {
      throw new Error('campaign-not-found');
    }
    if (!isV1Campaign(campaign)) {
      const builtTx = await this.createRefundTx(campaignId, refundAddress, refundAmount);
      const broadcast = await this.deps.broadcastRawTx(builtTx.rawHex);
      return { txid: broadcast.txid, builtTx };
    }

    const builtTx = await this.createRefundTx(campaignId, refundAddress, refundAmount);
    const broadcast = await this.deps.broadcastRawTx(builtTx.rawHex);
    const tracked = covenantIndexInstance.getCovenantRef(campaignId);
    const nextCovenantOutput = builtTx.unsignedTx.outputs[1];
    covenantIndexInstance.setCovenantRef({
      campaignId,
      txid: nextCovenantOutput ? broadcast.txid : '',
      vout: nextCovenantOutput ? 1 : 0,
      value: nextCovenantOutput?.value ?? 0n,
      scriptHash: tracked?.scriptHash ?? '',
      scriptPubKey: tracked?.scriptPubKey ?? '',
    });
    return { txid: broadcast.txid, builtTx };
  }

  async createRefundTx(campaignId: string, refundAddress: string, refundAmount: bigint): Promise<BuiltTx> {
    const campaign = await this.deps.campaignService.getCampaign(campaignId) as SpendableCampaignRecord | null;
    if (!campaign) {
      throw new Error('campaign-not-found');
    }

    const escrowAddress = resolveCampaignEscrowAddress(campaign);
    const spendableUtxos = filterSpendableUtxos(await this.deps.getUtxosForAddress(escrowAddress));
    const covenantUtxo = selectCampaignCovenantUtxo({
      campaignId,
      utxos: spendableUtxos,
      scriptPubKey: campaign.scriptPubKey,
      tracked: covenantIndexInstance.getCovenantRef(campaignId),
    });

    if (!isV1Campaign(campaign)) {
      return this.deps.buildRefundTx({
        covenantUtxo,
        refundAddress,
        refundAmount,
      });
    }

    const redeemScriptHex = requireV1RedeemScriptHex(campaign);
    const expirationTime = requireV1ExpirationTime(campaign);
    const refundOraclePubKey = requireV1RefundOraclePubKey(campaign);
    const refundOraclePrivKey = await resolvePrivateKeyFromEnv({
      privKeyEnvNames: ['TEYOLIA_REFUND_ORACLE_PRIVKEY', 'REFUND_ORACLE_PRIVKEY'],
      seedEnvNames: ['TEYOLIA_REFUND_ORACLE_SEED', 'REFUND_ORACLE_SEED'],
      publicKeyHex: refundOraclePubKey,
      missingError: 'refund-oracle-signing-key-not-configured',
      mismatchError: 'refund-oracle-signing-key-mismatch',
    });

    const fixedFee = 500n;

    const maxRefundAmount = covenantUtxo.value - fixedFee;
    if (maxRefundAmount <= 0n) {
      throw new Error('refund-insufficient-for-fee');
    }

    const safeRefundAmount = refundAmount > maxRefundAmount
      ? maxRefundAmount
      : refundAmount;

    return this.deps.buildRefundTx({
      covenantUtxo,
      refundAddress,
      refundAmount: safeRefundAmount,
      contractVersion: campaign.contractVersion ?? undefined,
      redeemScriptHex,
      refundOraclePrivKey,
      expirationTime,
      fixedFee,
    });
  }
}
