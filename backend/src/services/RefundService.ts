import { buildRefundTx, type BuiltTx } from '../blockchain/txBuilder';
import { broadcastRawTx, getUtxosForAddress } from '../blockchain/ecashClient';
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
import { getPledgeById, getConfirmedTotalByCampaign, markPledgeRefunded } from '../store/simplePledges';
import { coerceAmountToSats } from '../utils/ecashUnits';

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
  pledgeId: string;
  contributorAddress: string;
  refundAmountSats: string;
};

type RefundCampaignArgs = {
  campaignId: string;
  pledgeId: string;
};

type RefundableCampaignRecord = SpendableCampaignRecord & {
  goal?: string | number | bigint;
  expirationTime?: string | number | bigint;
  expiresAt?: string | null;
  status?: string | null;
};

function resolveCampaignExpirationMs(campaign: RefundableCampaignRecord): number {
  const explicit = campaign.expirationTime;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return Math.floor(explicit);
  }
  if (typeof explicit === 'bigint') {
    return Number(explicit);
  }
  if (typeof explicit === 'string' && explicit.trim()) {
    const asNumber = Number(explicit);
    if (Number.isFinite(asNumber)) {
      return Math.floor(asNumber);
    }
    const asDate = Date.parse(explicit);
    if (Number.isFinite(asDate)) {
      return asDate;
    }
  }
  const fallback = typeof campaign.expiresAt === 'string' ? Date.parse(campaign.expiresAt) : NaN;
  return Number.isFinite(fallback) ? fallback : 0;
}

export class RefundService {
  constructor(private readonly deps: RefundDependencies = defaultDependencies) {}

  async refundCampaign(args: RefundCampaignArgs): Promise<BroadcastRefundResult> {
    const campaign = await this.deps.campaignService.getCampaign(args.campaignId) as RefundableCampaignRecord | null;
    if (!campaign) {
      throw new Error('campaign-not-found');
    }

    const pledge = await getPledgeById(args.pledgeId);
    if (!pledge || pledge.campaignId !== args.campaignId) {
      throw new Error('pledge-not-found');
    }
    if (pledge.status === 'refunded') {
      throw new Error('pledge-already-refunded');
    }
    if (pledge.status === 'finalized') {
      throw new Error('pledge-not-refundable-after-finalization');
    }
    if (pledge.status !== 'confirmed') {
      throw new Error('pledge-not-refundable');
    }

    const expirationMs = resolveCampaignExpirationMs(campaign);
    if (!Number.isFinite(expirationMs) || expirationMs <= 0 || Date.now() < expirationMs) {
      throw new Error('refund-not-available-before-expiry');
    }

    const goalSats = coerceAmountToSats(campaign.goal ?? 0);
    const confirmedTotalSats = BigInt(await getConfirmedTotalByCampaign(args.campaignId));
    if (goalSats > 0n && confirmedTotalSats >= goalSats) {
      throw new Error('refund-not-available-goal-reached');
    }
    if ((campaign.status ?? '').toLowerCase() === 'paid_out') {
      throw new Error('refund-not-available-after-finalization');
    }

    const refundAmountSats = BigInt(pledge.amount);
    const builtTx = await this.createRefundTx(args.campaignId, pledge.contributorAddress, refundAmountSats);
    const broadcast = await this.deps.broadcastRawTx(builtTx.rawHex);

    if (isV1Campaign(campaign)) {
      const tracked = covenantIndexInstance.getCovenantRef(args.campaignId);
      const nextCovenantOutput = builtTx.unsignedTx.outputs[1];
      covenantIndexInstance.setCovenantRef({
        campaignId: args.campaignId,
        txid: nextCovenantOutput ? broadcast.txid : '',
        vout: nextCovenantOutput ? 1 : 0,
        value: nextCovenantOutput?.value ?? 0n,
        scriptHash: tracked?.scriptHash ?? '',
        scriptPubKey: tracked?.scriptPubKey ?? '',
      });
    }

    await markPledgeRefunded({
      pledgeId: pledge.pledgeId,
      refundTxid: broadcast.txid,
    });

    return {
      txid: broadcast.txid,
      builtTx,
      pledgeId: pledge.pledgeId,
      contributorAddress: pledge.contributorAddress,
      refundAmountSats: refundAmountSats.toString(),
    };
  }

  async createRefundTx(campaignId: string, refundAddress: string, refundAmountSats: bigint): Promise<BuiltTx> {
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
        refundAmount: refundAmountSats,
      });
    }

    const redeemScriptHex = requireV1RedeemScriptHex(campaign);
    const expirationTime = requireV1ExpirationTime(campaign);
    const refundOraclePubKey = requireV1RefundOraclePubKey(campaign);
    // TODO(security): V1 refunds still rely on a backend-held refund signer.
    // Replace this with user-claimable covenant refunds so the backend is only an indexer/cache.
    const refundOraclePrivKey = await resolvePrivateKeyFromEnv({
      privKeyEnvNames: ['TEYOLIA_REFUND_ORACLE_PRIVKEY', 'REFUND_ORACLE_PRIVKEY'],
      seedEnvNames: ['TEYOLIA_REFUND_ORACLE_SEED', 'REFUND_ORACLE_SEED'],
      publicKeyHex: refundOraclePubKey,
      missingError: 'refund-oracle-signing-key-not-configured',
      mismatchError: 'refund-oracle-signing-key-mismatch',
    });

    const fixedFee = 500n;
    const maxRefundAmountSats = covenantUtxo.value - fixedFee;
    if (maxRefundAmountSats <= 0n) {
      throw new Error('refund-insufficient-for-fee');
    }
    if (refundAmountSats > maxRefundAmountSats) {
      throw new Error('refund-insufficient-covenant-balance');
    }

    return this.deps.buildRefundTx({
      covenantUtxo,
      refundAddress,
      refundAmount: refundAmountSats,
      contractVersion: campaign.contractVersion ?? undefined,
      redeemScriptHex,
      refundOraclePrivKey,
      expirationTime,
      fixedFee,
    });
  }
}
