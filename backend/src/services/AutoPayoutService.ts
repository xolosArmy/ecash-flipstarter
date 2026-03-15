import { broadcastRawTx, getUtxosForAddress } from '../blockchain/ecashClient';
import {
  buildPayoutTx,
  derivePrivKeyFromSeed,
  signHybridPayoutTx,
} from '../blockchain/txBuilder';
import type { Utxo } from '../blockchain/types';
import { CampaignService } from './CampaignService';
import { validateAddress } from '../utils/validation';
import { coerceAmountToSats } from '../utils/ecashUnits';

type CampaignRecord = {
  id: string;
  goal: string;
  status?: string;
  activationFeePaid?: boolean;
  beneficiaryAddress?: string;
  recipientAddress?: string;
  campaignAddress?: string;
  covenantAddress?: string;
  redeemScriptHex?: string;
  payout?: {
    txid?: string | null;
    paidAt?: string | null;
  };
};

type AutoPayoutDependencies = {
  campaignService: Pick<CampaignService, 'getCampaign' | 'markPayoutComplete'>;
  getUtxosForAddress: (address: string) => Promise<Utxo[]>;
  buildPayoutTx: typeof buildPayoutTx;
  broadcastRawTx: typeof broadcastRawTx;
  derivePrivKeyFromSeed: typeof derivePrivKeyFromSeed;
  signHybridPayoutTx: typeof signHybridPayoutTx;
};

export type AutoPayoutResult =
  | {
    status: 'already_paid_out';
    campaignId: string;
    goalSats: bigint;
    raisedSats: bigint;
    txid: string;
  }
  | {
    status: 'paid_out';
    campaignId: string;
    goalSats: bigint;
    raisedSats: bigint;
    txid: string;
  };

const defaultDependencies: AutoPayoutDependencies = {
  campaignService: new CampaignService(),
  getUtxosForAddress,
  buildPayoutTx,
  broadcastRawTx,
  derivePrivKeyFromSeed,
  signHybridPayoutTx,
};

function resolveEscrowAddress(campaign: CampaignRecord): string {
  const candidate =
    campaign.campaignAddress
    || campaign.covenantAddress
    || campaign.recipientAddress
    || campaign.beneficiaryAddress;

  if (!candidate) {
    throw new Error('campaign-address-required');
  }

  return validateAddress(candidate, 'campaignAddress');
}

function resolveBeneficiaryAddress(campaign: CampaignRecord): string {
  const candidate = campaign.beneficiaryAddress || campaign.recipientAddress;
  if (!candidate) {
    throw new Error('beneficiary-address-required');
  }
  return validateAddress(candidate, 'beneficiaryAddress');
}

function sumSpendableUtxos(utxos: Utxo[]): bigint {
  return utxos.reduce((acc, utxo) => acc + utxo.value, 0n);
}

function filterSpendableUtxos(utxos: Utxo[]): Utxo[] {
  return utxos.filter((utxo) => !utxo.token && !utxo.slpToken && !utxo.tokenStatus && !utxo.plugins?.token);
}

export class AutoPayoutService {
  constructor(private readonly deps: AutoPayoutDependencies = defaultDependencies) {}

  async finalizeCampaign(campaignId: string): Promise<AutoPayoutResult> {
    const campaign = await this.deps.campaignService.getCampaign(campaignId) as CampaignRecord | null;
    if (!campaign) {
      throw new Error('campaign-not-found');
    }

    const goalSats = coerceAmountToSats(campaign.goal);
    const payoutTxid = campaign.payout?.txid?.trim().toLowerCase() ?? '';
    if (campaign.status === 'paid_out' || payoutTxid) {
      return {
        status: 'already_paid_out',
        campaignId: campaign.id,
        goalSats,
        raisedSats: 0n,
        txid: payoutTxid,
      };
    }

    if (!campaign.activationFeePaid) {
      throw new Error('activation-fee-unpaid');
    }
    if (!campaign.redeemScriptHex) {
      throw new Error('campaign-missing-redeem-script');
    }

    const escrowAddress = resolveEscrowAddress(campaign);
    const beneficiaryAddress = resolveBeneficiaryAddress(campaign);
    const campaignUtxos = filterSpendableUtxos(await this.deps.getUtxosForAddress(escrowAddress));
    const raisedSats = sumSpendableUtxos(campaignUtxos);

    if (raisedSats < goalSats) {
      throw new Error('goal-not-reached');
    }

    const gasSeed = process.env.GAS_WALLET_SEED;
    const gasAddress = process.env.GAS_WALLET_ADDRESS;
    if (!gasSeed || !gasAddress) {
      throw new Error('gas-wallet-not-configured-in-env');
    }

    const gasUtxos = filterSpendableUtxos(await this.deps.getUtxosForAddress(gasAddress));
    const feeSats = 500n;
    const gasUtxo = gasUtxos.find((utxo) => utxo.value >= feeSats && !!utxo.scriptPubKey);
    if (!gasUtxo) {
      throw new Error('gas-wallet-empty-or-insufficient-utxo');
    }

    const built = await this.deps.buildPayoutTx({
      campaignUtxos,
      gasUtxo,
      gasAddress,
      totalRaised: raisedSats,
      beneficiaryAddress,
      fixedFee: feeSats,
    });

    const privKey = await this.deps.derivePrivKeyFromSeed(gasSeed);
    const signedHex = this.deps.signHybridPayoutTx(
      built.unsignedTx,
      privKey,
      campaign.redeemScriptHex,
      built.unsignedTx.inputs.length - 1
    );

    const changeAmount = gasUtxo.value - built.fee;
    console.log('\n======================================================');
    console.log(`[Rescue Mode] Payout Autonomo Iniciado - ID: ${campaignId}`);
    console.log(`[Rescue Mode] Covenant Output (Beneficiario): ${raisedSats} sats`);
    console.log(`[Rescue Mode] Gas Input: ${gasUtxo.value} sats`);
    console.log(`[Rescue Mode] Fee Cobrado al Minero: ${built.fee} sats`);
    console.log(`[Rescue Mode] Cambio retornado a Gas Wallet: ${changeAmount > 0n ? changeAmount : 0n} sats`);
    console.log('======================================================\n');

    const broadcast = await this.deps.broadcastRawTx(signedHex);
    console.log(`[Rescue Mode] BROADCAST EXITOSO. TXID: ${broadcast.txid}\n`);
    await this.deps.campaignService.markPayoutComplete(campaign.id, broadcast.txid, null);

    return {
      status: 'paid_out',
      campaignId: campaign.id,
      goalSats,
      raisedSats,
      txid: broadcast.txid,
    };
  }
}
