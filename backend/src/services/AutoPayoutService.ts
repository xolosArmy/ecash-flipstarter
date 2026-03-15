import { broadcastRawTx, getUtxosForAddress } from '../blockchain/ecashClient';
import { buildPayoutTx } from '../blockchain/txBuilder';
import type { Utxo } from '../blockchain/types';
import { CampaignService } from './CampaignService';
import { validateAddress } from '../utils/validation';
import { coerceAmountToSats } from '../utils/ecashUnits';
import type { BuiltTx } from '../blockchain/txBuilder';

type CampaignRecord = {
  id: string;
  goal: string;
  status?: string;
  activationFeePaid?: boolean;
  beneficiaryAddress?: string;
  recipientAddress?: string;
  campaignAddress?: string;
  covenantAddress?: string;
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
  canBroadcastBuiltPayout: (built: BuiltTx) => boolean;
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
  canBroadcastBuiltPayout: () => false,
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

    const escrowAddress = resolveEscrowAddress(campaign);
    const beneficiaryAddress = resolveBeneficiaryAddress(campaign);
    const campaignUtxos = filterSpendableUtxos(await this.deps.getUtxosForAddress(escrowAddress));
    const raisedSats = sumSpendableUtxos(campaignUtxos);

    if (raisedSats < goalSats) {
      throw new Error('goal-not-reached');
    }

    const built = await this.deps.buildPayoutTx({
      campaignUtxos,
      totalRaised: raisedSats,
      beneficiaryAddress,
      fixedFee: 0n,
    });

    // The current repository only builds unsigned covenant spends with empty scriptSig
    // placeholders. Until the real finalize unlocking path is implemented backend-side,
    // broadcasting here would create an invalid transaction.
    if (!this.deps.canBroadcastBuiltPayout(built)) {
      throw new Error('auto-payout-spend-path-missing');
    }

    const broadcast = await this.deps.broadcastRawTx(built.rawHex);
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
