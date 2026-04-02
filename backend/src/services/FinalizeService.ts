import { buildFinalizeTx, type BuiltTx } from '../blockchain/txBuilder';
import { broadcastRawTx, getUtxosForAddress } from '../blockchain/ecashClient';
import type { Utxo } from '../blockchain/types';
import { coerceAmountToSats } from '../utils/ecashUnits';
import { CampaignService, covenantIndexInstance } from './CampaignService';
import { AutoPayoutService, type AutoPayoutResult } from './AutoPayoutService';
import {
  filterSpendableUtxos,
  isV1Campaign,
  requireV1BeneficiaryPubKey,
  requireV1RedeemScriptHex,
  resolveCampaignBeneficiaryAddress,
  resolveCampaignEscrowAddress,
  resolvePrivateKeyFromEnv,
  selectCampaignCovenantUtxo,
  type SpendableCampaignRecord,
} from './covenantV1Integration';

type FinalizeDependencies = {
  campaignService: Pick<CampaignService, 'getCampaign' | 'markPayoutComplete'>;
  getUtxosForAddress: typeof getUtxosForAddress;
  buildFinalizeTx: typeof buildFinalizeTx;
  broadcastRawTx: typeof broadcastRawTx;
  legacyFinalizeCampaign: (campaignId: string) => Promise<AutoPayoutResult>;
};

const defaultDependencies: FinalizeDependencies = {
  campaignService: new CampaignService(),
  getUtxosForAddress,
  buildFinalizeTx,
  broadcastRawTx,
  legacyFinalizeCampaign: (campaignId: string) => new AutoPayoutService().finalizeCampaign(campaignId),
};

export class FinalizeService {
  constructor(private readonly deps: FinalizeDependencies = defaultDependencies) {}

  async finalizeCampaign(campaignId: string): Promise<AutoPayoutResult> {
    const campaign = await this.deps.campaignService.getCampaign(campaignId) as SpendableCampaignRecord | null;
    if (!campaign) {
      throw new Error('campaign-not-found');
    }
    if (!isV1Campaign(campaign)) {
      return this.deps.legacyFinalizeCampaign(campaignId);
    }

    const payoutTxid = campaign.payout?.txid?.trim().toLowerCase() ?? '';
    if (campaign.status === 'paid_out' || payoutTxid) {
      return {
        status: 'already_paid_out',
        campaignId: campaign.id,
        goalSats: coerceAmountToSats(campaign.goal),
        raisedSats: 0n,
        txid: payoutTxid,
      };
    }
    if (!campaign.activationFeePaid) {
      throw new Error('activation-fee-unpaid');
    }

    const beneficiaryAddress = resolveCampaignBeneficiaryAddress(campaign);
    const beneficiaryPubKey = requireV1BeneficiaryPubKey(campaign);
    const redeemScriptHex = requireV1RedeemScriptHex(campaign);
    const beneficiaryPrivKey = await resolvePrivateKeyFromEnv({
      privKeyEnvNames: ['TEYOLIA_BENEFICIARY_PRIVKEY', 'BENEFICIARY_PRIVKEY'],
      seedEnvNames: ['TEYOLIA_BENEFICIARY_SEED', 'BENEFICIARY_SEED'],
      publicKeyHex: beneficiaryPubKey,
      missingError: 'beneficiary-signing-key-not-configured',
      mismatchError: 'beneficiary-signing-key-mismatch',
    });

    const escrowAddress = resolveCampaignEscrowAddress(campaign);
    const spendableUtxos = filterSpendableUtxos(await this.deps.getUtxosForAddress(escrowAddress));
    const covenantUtxo = selectCampaignCovenantUtxo({
      campaignId,
      utxos: spendableUtxos,
      scriptPubKey: campaign.scriptPubKey,
      tracked: covenantIndexInstance.getCovenantRef(campaignId),
    });

    const goalSats = coerceAmountToSats(campaign.goal);
    const raisedSats = covenantUtxo.value;
    if (raisedSats < goalSats) {
      throw new Error('goal-not-reached');
    }

    const gasWalletSeed = process.env.TEYOLIA_GAS_WALLET_SEED?.trim() || process.env.GAS_WALLET_SEED?.trim() || '';
    const gasWalletPrivKey =
      process.env.TEYOLIA_GAS_WALLET_PRIVKEY?.trim() || process.env.GAS_WALLET_PRIVKEY?.trim() || '';
    const gasWalletAddress =
      process.env.TEYOLIA_GAS_WALLET_ADDRESS?.trim() || process.env.GAS_WALLET_ADDRESS?.trim() || '';
    const hasGasSigner = Boolean(gasWalletPrivKey || gasWalletSeed);
    if ((hasGasSigner && !gasWalletAddress) || (!hasGasSigner && gasWalletAddress)) {
      throw new Error('gas-wallet-config-incomplete');
    }

    let gasUtxos: Utxo[] = [];
    let gasPrivKey: Buffer | null = null;
    if (hasGasSigner && gasWalletAddress) {
      const spendableGasUtxos = filterSpendableUtxos(await this.deps.getUtxosForAddress(gasWalletAddress));
      gasUtxos = selectGasUtxos(spendableGasUtxos, 500n);
      gasPrivKey = await resolvePrivateKeyFromEnv({
        privKeyEnvNames: ['TEYOLIA_GAS_WALLET_PRIVKEY', 'GAS_WALLET_PRIVKEY'],
        seedEnvNames: ['TEYOLIA_GAS_WALLET_SEED', 'GAS_WALLET_SEED'],
        missingError: 'gas-wallet-not-configured-in-env',
        mismatchError: 'gas-wallet-signing-key-mismatch',
      });
    }

    const built = await this.deps.buildFinalizeTx({
      covenantUtxo,
      beneficiaryAddress,
      contractVersion: campaign.contractVersion ?? undefined,
      redeemScriptHex,
      beneficiaryPrivKey,
      beneficiaryPubKey,
      gasUtxos,
      gasChangeAddress: gasUtxos.length > 0 ? gasWalletAddress : undefined,
      gasPrivKey,
      fixedFee: 500n,
    });

    const rawHex = built.rawHex;

    console.log('\n=== [DEBUG-V1] PRE-BROADCAST ===');
    console.log('Campaign ID:', campaignId);
    console.log(
      'Covenant UTXO:',
      `${covenantUtxo.txid}:${covenantUtxo.vout} (Valor: ${covenantUtxo.value})`,
    );
    console.log('Pledges Calculados (raisedSats):', raisedSats);
    console.log('Meta (goalSats):', goalSats);
    console.log('Raw TX Hex:', rawHex);
    console.log('================================\n');

    const broadcast = await this.deps.broadcastRawTx(rawHex);
    const tracked = covenantIndexInstance.getCovenantRef(campaignId);
    covenantIndexInstance.setCovenantRef({
      campaignId,
      txid: '',
      vout: 0,
      value: 0n,
      scriptHash: tracked?.scriptHash ?? '',
      scriptPubKey: tracked?.scriptPubKey ?? '',
    });
    await this.deps.campaignService.markPayoutComplete(campaignId, broadcast.txid, null);

    return {
      status: 'paid_out',
      campaignId,
      goalSats,
      raisedSats,
      txid: broadcast.txid,
    };
  }

  async createFinalizeTx(campaignId: string): Promise<BuiltTx> {
    const campaign = await this.deps.campaignService.getCampaign(campaignId) as SpendableCampaignRecord | null;
    if (!campaign) {
      throw new Error('campaign-not-found');
    }

    const beneficiaryAddress = resolveCampaignBeneficiaryAddress(campaign);
    const escrowAddress = resolveCampaignEscrowAddress(campaign);
    const covenantUtxo = selectCampaignCovenantUtxo({
      campaignId,
      utxos: filterSpendableUtxos(await this.deps.getUtxosForAddress(escrowAddress)),
      scriptPubKey: campaign.scriptPubKey,
      tracked: covenantIndexInstance.getCovenantRef(campaignId),
    });

    if (!isV1Campaign(campaign)) {
      return this.deps.buildFinalizeTx({
        covenantUtxo,
        beneficiaryAddress,
      });
    }

    const beneficiaryPubKey = requireV1BeneficiaryPubKey(campaign);
    const redeemScriptHex = requireV1RedeemScriptHex(campaign);
    const beneficiaryPrivKey = await resolvePrivateKeyFromEnv({
      privKeyEnvNames: ['TEYOLIA_BENEFICIARY_PRIVKEY', 'BENEFICIARY_PRIVKEY'],
      seedEnvNames: ['TEYOLIA_BENEFICIARY_SEED', 'BENEFICIARY_SEED'],
      publicKeyHex: beneficiaryPubKey,
      missingError: 'beneficiary-signing-key-not-configured',
      mismatchError: 'beneficiary-signing-key-mismatch',
    });

    return this.deps.buildFinalizeTx({
      covenantUtxo,
      beneficiaryAddress,
      contractVersion: campaign.contractVersion ?? undefined,
      redeemScriptHex,
      beneficiaryPrivKey,
      beneficiaryPubKey,
    });
  }
}

function selectGasUtxos(utxos: Utxo[], feeTarget: bigint): Utxo[] {
  const selected: Utxo[] = [];
  let total = 0n;
  for (const utxo of utxos) {
    if (!utxo.scriptPubKey) {
      continue;
    }
    selected.push(utxo);
    total += utxo.value;
    if (total >= feeTarget) {
      return selected;
    }
  }
  throw new Error('gas-wallet-empty-or-insufficient-utxo');
}
