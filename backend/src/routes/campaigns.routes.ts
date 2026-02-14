import { Router } from 'express';
import { CampaignService } from '../services/CampaignService';
import { validateAddress } from '../utils/validation';
import { getPledgesByCampaign } from '../store/simplePledges';
import { getUtxosForAddress } from '../blockchain/ecashClient';
import { buildPayoutTx, buildSimplePaymentTx } from '../blockchain/txBuilder';
import { serializeBuiltTx } from './serialize';
import { walletConnectOfferStore } from '../services/WalletConnectOfferStore';
import { ACTIVATION_FEE_SATS, ACTIVATION_FEE_XEC, TREASURY_ADDRESS } from '../config/constants';

type CampaignStatus = 'draft' | 'pending_fee' | 'active' | 'expired' | 'funded' | 'paid_out';

type CampaignApiRecord = {
  id: string;
  name: string;
  description?: string;
  goal: string;
  expirationTime: string;
  beneficiaryAddress?: string;
  recipientAddress?: string;
  campaignAddress?: string;
  covenantAddress?: string;
  status?: CampaignStatus;
  progress?: number;
  activation?: {
    feeSats?: string;
    feeTxid?: string | null;
    feePaidAt?: string | null;
    payerAddress?: string | null;
    wcOfferId?: string | null;
  };
  activationFeeRequired?: number;
  activationFeePaid?: boolean;
  activationFeeTxid?: string | null;
  activationFeePaidAt?: string | null;
  payout?: {
    wcOfferId?: string | null;
    txid?: string | null;
    paidAt?: string | null;
  };
  treasuryAddressUsed?: string | null;
};

const TXID_HEX_REGEX = /^[0-9a-f]{64}$/i;

const router = Router();
const service = new CampaignService();

async function getTotalPledged(campaignId: string): Promise<number> {
  const pledges = await getPledgesByCampaign(campaignId);
  return pledges.reduce((total, pledge) => total + pledge.amount, 0);
}

function toCampaignActivationFeeRequired(campaign: CampaignApiRecord): number {
  if (typeof campaign.activationFeeRequired === 'number' && Number.isFinite(campaign.activationFeeRequired)) {
    return Math.floor(campaign.activationFeeRequired);
  }
  const feeSats = Number(campaign.activation?.feeSats ?? ACTIVATION_FEE_SATS.toString());
  if (Number.isFinite(feeSats) && feeSats > 0) {
    return Math.floor(feeSats / 100);
  }
  return ACTIVATION_FEE_XEC;
}

function isActivationFeePaid(campaign: CampaignApiRecord): boolean {
  if (typeof campaign.activationFeePaid === 'boolean') {
    return campaign.activationFeePaid;
  }
  return Boolean(campaign.activationFeeTxid || campaign.activation?.feeTxid);
}

function getActivationFeeTxid(campaign: CampaignApiRecord): string | null {
  return campaign.activationFeeTxid ?? campaign.activation?.feeTxid ?? null;
}

function getActivationFeePaidAt(campaign: CampaignApiRecord): string | null {
  return campaign.activationFeePaidAt ?? campaign.activation?.feePaidAt ?? null;
}

function deriveCampaignStatus(campaign: CampaignApiRecord, totalPledged: number): CampaignStatus {
  if (campaign.status === 'draft') {
    return 'draft';
  }
  if (campaign.status === 'paid_out') {
    return 'paid_out';
  }

  const activationPaid = isActivationFeePaid(campaign);
  if (!activationPaid) {
    return 'pending_fee';
  }

  const goal = Number(campaign.goal);
  if (Number.isFinite(goal) && totalPledged >= goal) {
    return 'funded';
  }

  const expirationMs = Number(campaign.expirationTime);
  if (Number.isFinite(expirationMs) && expirationMs <= Date.now()) {
    return 'expired';
  }

  return 'active';
}

function toSummary(campaign: CampaignApiRecord, totalPledged: number) {
  const status = deriveCampaignStatus(campaign, totalPledged);
  const activationFeeRequired = toCampaignActivationFeeRequired(campaign);
  const activationFeeTxid = getActivationFeeTxid(campaign);
  const activationFeePaidAt = getActivationFeePaidAt(campaign);

  return {
    ...campaign,
    totalPledged,
    pledgeCount: 0,
    status,
    activationFeeRequired,
    activationFeePaid: isActivationFeePaid(campaign),
    activationFeeTxid,
    activationFeePaidAt,
    activation: {
      feeSats: campaign.activation?.feeSats ?? String(activationFeeRequired * 100),
      feeTxid: activationFeeTxid,
      feePaidAt: activationFeePaidAt,
      payerAddress: campaign.activation?.payerAddress ?? null,
      wcOfferId: campaign.activation?.wcOfferId ?? null,
    },
  };
}

function sanitizeTxid(raw: unknown): string {
  const txid = String(raw ?? '').trim().toLowerCase();
  if (!TXID_HEX_REGEX.test(txid)) {
    throw new Error('txid-invalid');
  }
  return txid;
}

function resolveCampaignEscrowAddress(campaign: CampaignApiRecord): string {
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

async function getCampaignOr404(req: any, res: any): Promise<CampaignApiRecord | null> {
  const campaign = (await service.getCampaign(req.params.id)) as CampaignApiRecord | null;
  if (!campaign) {
    res.status(404).json({ error: 'campaign-not-found' });
    return null;
  }
  return campaign;
}

// GET /api/campaigns
router.get('/', async (_req, res) => {
  try {
    const list = await service.listCampaigns();
    res.json(list);
  } catch (_error) {
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

router.get('/campaign', async (_req, res) => {
  try {
    const list = await service.listCampaigns();
    res.json(list);
  } catch (_error) {
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

router.get('/campaigns', async (_req, res) => {
  try {
    const list = await service.listCampaigns();
    res.json(list);
  } catch (_error) {
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

// GET /api/stats and /api/campaigns/stats
async function getCampaignStats(_req: any, res: any) {
  try {
    const stats = await service.getGlobalStats();
    return res.json(stats);
  } catch (_error) {
    return res.status(500).json({ error: 'Failed to compute stats' });
  }
}

router.get('/stats', getCampaignStats);
router.get('/campaigns/stats', getCampaignStats);

router.get('/campaign/:id', async (req, res) => {
  try {
    const campaign = await service.getCampaign(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    return res.json(campaign);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await service.getCampaign(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    return res.json(campaign);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/campaign', async (req, res) => {
  try {
    if (typeof req.body?.beneficiaryAddress === 'string' && req.body.beneficiaryAddress.trim()) {
      req.body.beneficiaryAddress = validateAddress(req.body.beneficiaryAddress, 'beneficiaryAddress');
    }
    const campaign = await service.createCampaign(req.body ?? {});
    res.status(201).json(campaign);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/campaigns', async (req, res) => {
  try {
    if (typeof req.body?.beneficiaryAddress === 'string' && req.body.beneficiaryAddress.trim()) {
      req.body.beneficiaryAddress = validateAddress(req.body.beneficiaryAddress, 'beneficiaryAddress');
    }
    const campaign = await service.createCampaign(req.body ?? {});
    res.status(201).json(campaign);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Legacy endpoint: only allows ACTIVE when fee is paid.
async function activateCampaign(req: any, res: any) {
  const { id } = req.params;
  try {
    const campaign = await service.getCampaign(id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    await service.updateCampaignStatus(id, 'active');
    return res.json({ success: true, status: 'active' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'activation-fee-unpaid') {
      return res.status(400).json({ error: 'activation-fee-unpaid' });
    }
    return res.status(500).json({ error: 'Failed to activate campaign' });
  }
}

async function processCampaignPayout(req: any, res: any) {
  const { id } = req.params;
  try {
    const campaign = await service.getCampaign(id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    await service.updateCampaignStatus(id, 'funded');
    return res.json({ success: true, status: 'funded' });
  } catch (_error) {
    return res.status(500).json({ error: 'Failed to process payout' });
  }
}

router.post('/campaign/:id/activate', activateCampaign);
router.post('/campaigns/:id/activate', activateCampaign);
router.post('/campaign/:id/payout', processCampaignPayout);
router.post('/campaigns/:id/payout', processCampaignPayout);

// Dedicated implementation shared by activation aliases.
const buildActivationHandler: Parameters<typeof router.post>[1] = async (req, res) => {
  try {
    const campaign = await getCampaignOr404(req, res);
    if (!campaign) return;

    if (isActivationFeePaid(campaign)) {
      return res.status(400).json({ error: 'activation-fee-already-paid' });
    }

    const payerAddress = validateAddress(req.body?.payerAddress as string, 'payerAddress');
    const payerUtxos = (await getUtxosForAddress(payerAddress)).filter(
      (utxo) => !utxo.token && !utxo.slpToken && !utxo.tokenStatus && !utxo.plugins?.token,
    );

    const amount = BigInt(toCampaignActivationFeeRequired(campaign) * 100);
    const built = await buildSimplePaymentTx({
      contributorUtxos: payerUtxos,
      amount,
      contributorAddress: payerAddress,
      beneficiaryAddress: TREASURY_ADDRESS,
      fixedFee: 500n,
    });

    const serialized = serializeBuiltTx(built);
    const unsignedTxHex = serialized.unsignedTxHex || serialized.rawHex;
    const offer = walletConnectOfferStore.createOffer({
      campaignId: campaign.id,
      unsignedTxHex,
      amount: amount.toString(),
      contributorAddress: payerAddress,
    });

    await service.setActivationOffer(campaign.id, offer.offerId, payerAddress);

    return res.json({
      ...serialized,
      feeSats: amount.toString(),
      payerAddress,
      campaignId: campaign.id,
      wcOfferId: offer.offerId,
      treasuryAddress: TREASURY_ADDRESS,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

router.post('/campaign/:id/pay-activation-fee', buildActivationHandler);
router.post('/campaigns/:id/pay-activation-fee', buildActivationHandler);
router.post('/campaign/:id/activation/build', buildActivationHandler);
router.post('/campaigns/:id/activation/build', buildActivationHandler);

const confirmActivationHandler: Parameters<typeof router.post>[1] = async (req, res) => {
  try {
    const campaign = await getCampaignOr404(req, res);
    if (!campaign) return;

    const txid = sanitizeTxid(req.body?.txid);
    const payerAddress =
      typeof req.body?.payerAddress === 'string' && req.body.payerAddress.trim()
        ? validateAddress(req.body.payerAddress, 'payerAddress')
        : null;

    await service.markActivationFeePaid(campaign.id, txid, {
      payerAddress,
    });

    const updated = (await service.getCampaign(campaign.id)) as CampaignApiRecord | null;
    if (!updated) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }

    const totalPledged = await getTotalPledged(campaign.id);
    const summary = toSummary(updated, totalPledged);
    return res.json({
      ...summary,
      pledgeCount: (await getPledgesByCampaign(campaign.id)).length,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

router.post('/campaign/:id/activation/confirm', confirmActivationHandler);
router.post('/campaigns/:id/activation/confirm', confirmActivationHandler);

router.get('/campaigns/:id/activation/status', async (req, res) => {
  try {
    const campaign = await getCampaignOr404(req, res);
    if (!campaign) return;

    const totalPledged = await getTotalPledged(campaign.id);
    const summary = toSummary(campaign, totalPledged);

    return res.json({
      status: summary.status,
      feeTxid: summary.activationFeeTxid ?? undefined,
      feePaidAt: summary.activationFeePaidAt ?? undefined,
      activationFeeRequired: summary.activationFeeRequired,
      activationFeePaid: summary.activationFeePaid,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/campaigns/:id/payout/build', async (req, res) => {
  try {
    const campaign = await getCampaignOr404(req, res);
    if (!campaign) return;

    if (!isActivationFeePaid(campaign)) {
      return res.status(400).json({ error: 'activation-fee-unpaid' });
    }

    const totalPledged = await getTotalPledged(campaign.id);
    const summary = toSummary(campaign, totalPledged);
    if (summary.status !== 'funded') {
      return res.status(400).json({ error: 'campaign-not-funded' });
    }

    const campaignAddress = resolveCampaignEscrowAddress(campaign);
    const campaignUtxos = (await getUtxosForAddress(campaignAddress)).filter(
      (utxo) => !utxo.token && !utxo.slpToken && !utxo.tokenStatus && !utxo.plugins?.token,
    );

    const beneficiaryAddress = validateAddress(
      campaign.beneficiaryAddress || campaign.recipientAddress || '',
      'beneficiaryAddress',
    );

    const built = await buildPayoutTx({
      campaignUtxos,
      totalRaised: BigInt(Math.floor(totalPledged)),
      beneficiaryAddress,
      treasuryAddress: TREASURY_ADDRESS,
      fixedFee: 500n,
    });

    const serialized = serializeBuiltTx(built);
    const offer = walletConnectOfferStore.createOffer({
      campaignId: campaign.id,
      unsignedTxHex: serialized.unsignedTxHex || serialized.rawHex,
      amount: String(totalPledged),
      contributorAddress: beneficiaryAddress,
    });

    await service.setPayoutOffer(campaign.id, offer.offerId);

    return res.json({
      ...serialized,
      beneficiaryAmount: built.beneficiaryAmount.toString(),
      treasuryCut: built.treasuryCut.toString(),
      treasuryAddress: TREASURY_ADDRESS,
      wcOfferId: offer.offerId,
      campaignId: campaign.id,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/campaigns/:id/payout/confirm', async (req, res) => {
  try {
    const campaign = await getCampaignOr404(req, res);
    if (!campaign) return;

    const txid = sanitizeTxid(req.body?.txid);
    await service.markPayoutComplete(campaign.id, txid, TREASURY_ADDRESS);

    const updated = (await service.getCampaign(campaign.id)) as CampaignApiRecord | null;
    if (!updated) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }

    const pledges = await getPledgesByCampaign(campaign.id);
    const totalPledged = pledges.reduce((total, pledge) => total + pledge.amount, 0);
    const summary = toSummary(updated, totalPledged);

    return res.json({
      ...summary,
      pledgeCount: pledges.length,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/campaigns/:id/pledges', async (req, res) => {
  try {
    const campaign = await service.getCampaign(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const pledges = await getPledgesByCampaign(req.params.id);
    const totalPledged = pledges.reduce((total, pledge) => total + pledge.amount, 0);
    return res.json({
      totalPledged,
      pledgeCount: pledges.length,
      pledges: pledges.map((pledge) => ({
        txid: pledge.txid,
        contributorAddress: pledge.contributorAddress,
        amount: pledge.amount,
        timestamp: pledge.timestamp,
        message: pledge.message,
      })),
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/campaigns/:id/summary', async (req, res) => {
  try {
    const campaign = (await service.getCampaign(req.params.id)) as CampaignApiRecord | null;
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const pledges = await getPledgesByCampaign(req.params.id);
    const totalPledged = pledges.reduce((total, pledge) => total + pledge.amount, 0);
    const summary = toSummary(campaign, totalPledged);

    return res.json({
      ...summary,
      pledgeCount: pledges.length,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/campaign/:id/history', async (req, res) => {
  try {
    const campaign = await service.getCampaign(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const history = await service.getCampaignHistory(req.params.id);
    return res.json(history);
  } catch (_error) {
    return res.status(500).json({ error: 'Failed to fetch campaign history' });
  }
});

router.get('/campaigns/:id/history', async (req, res) => {
  try {
    const campaign = await service.getCampaign(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const history = await service.getCampaignHistory(req.params.id);
    return res.json(history);
  } catch (_error) {
    return res.status(500).json({ error: 'Failed to fetch campaign history' });
  }
});

export async function getCampaignStatusById(campaignId: string): Promise<CampaignStatus | null> {
  const campaign = (await service.getCampaign(campaignId)) as CampaignApiRecord | null;
  if (!campaign) {
    return null;
  }
  const totalPledged = await getTotalPledged(campaignId);
  return deriveCampaignStatus(campaign, totalPledged);
}

export default router;
