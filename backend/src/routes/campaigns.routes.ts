import { Router } from 'express';
import { CampaignService } from '../services/CampaignService';
import { validateAddress } from '../utils/validation';
import { getPledgesByCampaign } from '../store/simplePledges';
import { addressToScriptPubKey, getTransactionInfo } from '../blockchain/ecashClient';
import { walletConnectOfferStore } from '../services/WalletConnectOfferStore';
import {
  ACTIVATION_FEE_SATS,
  ACTIVATION_FEE_TOKEN_AMOUNT_RAW,
  ACTIVATION_FEE_TOKEN_DUST_SATS,
  ACTIVATION_FEE_TOKEN_ID,
  ACTIVATION_FEE_TOKEN_PROTOCOL,
  ACTIVATION_FEE_XEC,
  TREASURY_ADDRESS,
} from '../config/constants';
import { coerceAmountToSats } from '../utils/ecashUnits';
import { FinalizeService } from '../services/FinalizeService';

type CampaignStatus =
  | 'draft'
  | 'created'
  | 'pending_fee'
  | 'pending_verification'
  | 'fee_invalid'
  | 'active'
  | 'expired'
  | 'funded'
  | 'paid_out';

type CampaignApiRecord = {
  id: string;
  slug?: string;
  name: string;
  description?: string;
  goal: string;
  expirationTime: string;
  expiresAt?: string;
  createdAt?: string;
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
  activationFeeVerificationStatus?: 'none' | 'pending_verification' | 'verified' | 'invalid';
  activationFeeVerifiedAt?: string | null;
  activationOfferMode?: 'tx' | 'intent' | null;
  activationOfferOutputs?: Array<{
    address: string;
    valueSats: number;
    token?: {
      protocol: 'ALP';
      tokenId: string;
      tokenAmount: string;
    };
  }> | null;
  activationTreasuryAddressUsed?: string | null;
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
const finalizeService = new FinalizeService();

function validateCampaignIdParam(raw: unknown): string {
  const campaignId = String(raw ?? '').trim();
  if (!campaignId || !/^[A-Za-z0-9._:-]+$/.test(campaignId)) {
    throw new Error('campaign-id-invalid');
  }
  return campaignId;
}

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
  if (campaign.activationFeeVerificationStatus === 'verified') {
    return true;
  }
  return campaign.status === 'active'
    || campaign.status === 'funded'
    || campaign.status === 'expired'
    || campaign.status === 'paid_out';
}

function getActivationFeeTxid(campaign: CampaignApiRecord): string | null {
  return campaign.activationFeeTxid ?? campaign.activation?.feeTxid ?? null;
}

function getActivationFeePaidAt(campaign: CampaignApiRecord): string | null {
  return campaign.activationFeePaidAt ?? campaign.activation?.feePaidAt ?? null;
}

function deriveCampaignStatus(campaign: CampaignApiRecord, totalPledged: number): CampaignStatus {
  if (campaign.status === 'pending_verification') {
    return 'pending_verification';
  }
  if (campaign.status === 'fee_invalid') {
    return 'fee_invalid';
  }
  if (campaign.status === 'paid_out') {
    return 'paid_out';
  }

  const activationPaid = isActivationFeePaid(campaign);
  if (!activationPaid) {
    if (campaign.status === 'draft') {
      return 'draft';
    }
    return 'pending_fee';
  }

  const goalSats = coerceAmountToSats(campaign.goal);
  if (goalSats > 0n && BigInt(totalPledged) >= goalSats) {
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
    activationFeeVerificationStatus: campaign.activationFeeVerificationStatus ?? 'none',
    activationFeeVerifiedAt: campaign.activationFeeVerifiedAt ?? null,
    activation: {
      feeSats: campaign.activation?.feeSats ?? String(activationFeeRequired * 100),
      feeTxid: activationFeeTxid,
      feePaidAt: activationFeePaidAt,
      payerAddress: campaign.activation?.payerAddress ?? null,
      wcOfferId: campaign.activation?.wcOfferId ?? null,
    },
    activationOfferMode: campaign.activationOfferMode ?? null,
    activationOfferOutputs: campaign.activationOfferOutputs ?? null,
    activationTreasuryAddressUsed: campaign.activationTreasuryAddressUsed ?? null,
  };
}

function sanitizeTxid(raw: unknown): string {
  const txid = String(raw ?? '').trim().toLowerCase();
  if (!TXID_HEX_REGEX.test(txid)) {
    throw new Error('txid-invalid');
  }
  return txid;
}

type VerificationResult =
  | {
    status: 'verified';
    confirmations: number;
    treasuryOk: true;
    dustOk: true;
    tokenOk: true;
    amountOk: true;
  }
  | {
    status: 'pending_verification';
    warning: string;
    confirmations: number;
    treasuryOk: boolean;
    dustOk: boolean;
    tokenOk: boolean;
    amountOk: boolean;
  }
  | {
    status: 'invalid';
    error: string;
    confirmations: number;
    treasuryOk: boolean;
    dustOk: boolean;
    tokenOk: boolean;
    amountOk: boolean;
  };

async function verifyActivationTxBestEffort(
  txid: string,
  treasuryAddress: string,
  activationFeeRequiredTokenAmount: bigint,
): Promise<VerificationResult> {
  try {
    const treasuryScript = (await addressToScriptPubKey(treasuryAddress)).toLowerCase();
    const tx = await getTransactionInfo(txid);
    const treasuryOutputs = tx.outputs.filter(
      (output) => output.scriptPubKey.toLowerCase() === treasuryScript,
    );
    const treasuryOk = treasuryOutputs.length > 0;
    const dustOk = treasuryOutputs.some((output) => output.valueSats >= ACTIVATION_FEE_TOKEN_DUST_SATS);
    const tokenOk = treasuryOutputs.some(
      (output) => output.token?.protocol === ACTIVATION_FEE_TOKEN_PROTOCOL && output.token.tokenId === ACTIVATION_FEE_TOKEN_ID,
    );
    const amountOk = treasuryOutputs.some(
      (output) => output.token?.amount !== undefined && output.token.amount >= activationFeeRequiredTokenAmount,
    );
    const confirmations = Math.max(
      Number.isFinite(tx.confirmations) ? Math.floor(tx.confirmations) : 0,
      tx.height >= 0 ? 1 : 0,
    );
    if (!treasuryOk || !dustOk || !tokenOk || !amountOk) {
      return {
        status: 'invalid',
        error: 'activation-fee-output-mismatch',
        confirmations,
        treasuryOk,
        dustOk,
        tokenOk,
        amountOk,
      };
    }
    if (confirmations < 1) {
      return {
        status: 'pending_verification',
        warning: 'activation-fee-unconfirmed',
        confirmations,
        treasuryOk,
        dustOk,
        tokenOk,
        amountOk,
      };
    }
    return {
      status: 'verified',
      confirmations,
      treasuryOk: true,
      dustOk: true,
      tokenOk: true,
      amountOk: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[activation] chronik unavailable', { txid, message });
    return {
      status: 'pending_verification',
      warning: 'chronik-unavailable',
      confirmations: 0,
      treasuryOk: false,
      dustOk: false,
      tokenOk: false,
      amountOk: false,
    };
  }
}

async function toActivationResponse(campaignId: string, campaign: CampaignApiRecord, warning?: string, txid?: string) {
  const totalPledged = await getTotalPledged(campaign.id);
  const summary = toSummary(campaign, totalPledged);
  return {
    ...summary,
    pledgeCount: (await getPledgesByCampaign(campaign.id)).length,
    campaignId,
    txid: txid ?? summary.activationFeeTxid ?? null,
    feeTxid: summary.activationFeeTxid ?? undefined,
    feePaidAt: summary.activationFeePaidAt ?? undefined,
    activationFeeVerificationStatus: summary.activationFeeVerificationStatus ?? 'none',
    verificationStatus: summary.activationFeeVerificationStatus ?? 'none',
    warning,
  };
}

function normalizeCampaign(c: any) {
  const safeId = typeof c?.id === 'string' && c.id.trim() && c.id !== 'undefined' ? c.id : undefined;
  const safeSlug = typeof c?.slug === 'string' && c.slug.trim() && c.slug !== 'undefined' ? c.slug : undefined;
  const canonicalAddress = c?.covenantAddress || c?.campaignAddress || c?.escrowAddress || c?.recipientAddress;
  const stableKey = safeId || safeSlug || canonicalAddress || c?.id || c?.slug || '';

  return {
    ...c,
    id: stableKey,
    slug: stableKey,
    campaignAddress: canonicalAddress,
    covenantAddress: canonicalAddress,
    escrowAddress: canonicalAddress,
  };
}

function isPublicCampaign(c: any): boolean {
  return typeof c?.id === 'string' && c.id.startsWith('campaign-');
}

function resolveCampaignBeneficiaryAddress(campaign: CampaignApiRecord): string {
  const candidate = campaign.beneficiaryAddress || campaign.recipientAddress;
  if (!candidate) {
    throw new Error('beneficiary-address-required');
  }
  return validateAddress(candidate, 'beneficiaryAddress');
}

function isValidationError(message: string): boolean {
  return message.includes('invalid')
    || message.includes('required')
    || message.includes('insufficient-funds')
    || message.includes('campaign-funds-empty')
    || message.includes('activation-fee-unpaid');
}

async function getCampaignOr404(req: any, res: any): Promise<CampaignApiRecord | null> {
  let campaignId: string;
  try {
    campaignId = validateCampaignIdParam(req.params.id);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return null;
  }
  const campaign = (await resolveCampaignByIdentifier(campaignId)) as CampaignApiRecord | null;
  if (!campaign) {
    res.status(404).json({ error: 'campaign-not-found' });
    return null;
  }
  return campaign;
}

async function resolveCampaignByIdentifier(identifier: string): Promise<CampaignApiRecord | null> {
  const direct = (await service.getCampaign(identifier)) as CampaignApiRecord | null;
  if (direct) {
    return direct;
  }

  const list = (await service.listCampaigns()) as CampaignApiRecord[];
  return list.find((campaign) => campaign.slug === identifier || campaign.id === identifier) ?? null;
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
    let camps = await service.listCampaigns();
    if (camps.length === 0) {
      return res.json((camps || []).filter(isPublicCampaign).map(normalizeCampaign));
    }
    return res.json((camps || []).filter(isPublicCampaign).map(normalizeCampaign));
  } catch (_error) {
    return res.status(500).json({ error: 'Failed to fetch campaigns' });
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

router.get('/campaigns/slug/:slug', async (req, res) => {
  try {
    const campaign = await service.getCampaign(req.params.slug);
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
export const buildActivationHandler: Parameters<typeof router.post>[1] = async (req, res) => {
  try {
    const campaign = await getCampaignOr404(req, res);
    if (!campaign) return;

    if (isActivationFeePaid(campaign)) {
      return res.status(400).json({ error: 'activation-fee-already-paid' });
    }

    const payerAddress = validateAddress(req.body?.payerAddress as string, 'payerAddress');
    const activationFeeRequired = toCampaignActivationFeeRequired(campaign);
    const amount = BigInt(ACTIVATION_FEE_TOKEN_AMOUNT_RAW);
    const activationFeeTxid = getActivationFeeTxid(campaign);
    const persistedOutputs =
      Array.isArray(campaign.activationOfferOutputs) && campaign.activationOfferOutputs.length > 0
        ? campaign.activationOfferOutputs
        : null;
    const treasuryAddress = campaign.activationTreasuryAddressUsed || TREASURY_ADDRESS;
    const outputs = persistedOutputs ?? [{
      address: treasuryAddress,
      valueSats: Number(ACTIVATION_FEE_TOKEN_DUST_SATS),
      token: {
        protocol: ACTIVATION_FEE_TOKEN_PROTOCOL,
        tokenId: ACTIVATION_FEE_TOKEN_ID,
        tokenAmount: ACTIVATION_FEE_TOKEN_AMOUNT_RAW,
      },
    }];
    const userPrompt = 'Pagar fee de activación';
    const shouldLogOfferCreated =
      campaign.status === 'pending_fee'
      && !persistedOutputs
      && !activationFeeTxid;

    const persistedOfferId =
      typeof campaign.activation?.wcOfferId === 'string' && campaign.activation.wcOfferId.trim()
        ? campaign.activation.wcOfferId.trim()
        : null;
    if (!shouldLogOfferCreated && persistedOfferId && persistedOutputs) {
      return res.json({
        offerId: persistedOfferId,
        wcOfferId: persistedOfferId,
        mode: campaign.activationOfferMode ?? 'intent',
        activationFeeRequired,
        feeSats: amount.toString(),
        payerAddress,
        campaignId: campaign.id,
        treasuryAddress,
        outputs,
        userPrompt,
        // Deprecated compatibility fields from tx-build mode.
        inputsUsed: [],
        outpoints: [],
      });
    }

    const offer = walletConnectOfferStore.createOffer({
      campaignId: campaign.id,
      mode: 'intent',
      outputs,
      userPrompt,
      amount: amount.toString(),
      contributorAddress: payerAddress,
    });

    await service.setActivationOffer(campaign.id, offer.offerId, payerAddress, {
      mode: 'intent',
      outputs,
      treasuryAddressUsed: treasuryAddress,
      logAuditEvent: shouldLogOfferCreated,
    });

    return res.json({
      offerId: offer.offerId,
      wcOfferId: offer.offerId,
      mode: 'intent',
      activationFeeRequired,
      feeSats: amount.toString(),
      payerAddress,
      campaignId: campaign.id,
      treasuryAddress,
      outputs,
      userPrompt,
      // Deprecated compatibility fields from tx-build mode.
      inputsUsed: [],
      outpoints: [],
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

router.post('/campaign/:id/pay-activation-fee', buildActivationHandler);
router.post('/campaigns/:id/pay-activation-fee', buildActivationHandler);
router.post('/campaign/:id/activation/build', buildActivationHandler);
router.post('/campaigns/:id/activation/build', buildActivationHandler);

export const confirmActivationHandler: Parameters<typeof router.post>[1] = async (req, res) => {
  try {
    const campaign = await getCampaignOr404(req, res);
    if (!campaign) return;

    const txid = sanitizeTxid(req.body?.txid);
    const payerAddress =
      typeof req.body?.payerAddress === 'string' && req.body.payerAddress.trim()
        ? validateAddress(req.body.payerAddress, 'payerAddress')
        : null;
    const activationFeeRequiredTokenAmount = BigInt(ACTIVATION_FEE_TOKEN_AMOUNT_RAW);
    const treasuryAddress =
      campaign.activationTreasuryAddressUsed
      || campaign.treasuryAddressUsed
      || TREASURY_ADDRESS;

    const existingTxid = (campaign.activationFeeTxid ?? campaign.activation?.feeTxid ?? '').toLowerCase();
    const existingVerification = campaign.activationFeeVerificationStatus ?? 'none';
    if (existingVerification === 'verified' && existingTxid) {
      if (existingTxid !== txid) {
        return res.status(400).json({ error: 'activation-fee-already-verified' });
      }
      return res.json(await toActivationResponse(campaign.id, campaign, undefined, txid));
    }

    await service.recordActivationFeeBroadcast(campaign.id, txid, {
      paidAt: new Date().toISOString(),
      payerAddress,
      treasuryAddressUsed: treasuryAddress,
    });

    const verification = await verifyActivationTxBestEffort(txid, treasuryAddress, activationFeeRequiredTokenAmount);
    if (process.env.NODE_ENV !== 'production') {
      console.debug('[activation] confirm', {
        id: campaign.id,
        txid,
        result: verification.status,
        confs: verification.confirmations,
        treasuryOk: verification.treasuryOk,
        dustOk: verification.dustOk,
        tokenOk: verification.tokenOk,
        amountOk: verification.amountOk,
      });
    }
    if (verification.status === 'invalid') {
      await service.finalizeActivationFeeVerification(campaign.id, txid, 'invalid', {
        payerAddress,
        treasuryAddressUsed: treasuryAddress,
        reason: verification.error,
      });
      const updatedInvalid = (await service.getCampaign(campaign.id)) as CampaignApiRecord | null;
      if (!updatedInvalid) {
        return res.status(404).json({ error: 'campaign-not-found' });
      }
      return res.json({
        ...(await toActivationResponse(campaign.id, updatedInvalid, verification.error, txid)),
        message: 'Pago inválido: la transacción no cumple monto o dirección de treasury.',
      });
    }

    if (verification.status === 'verified') {
      await service.finalizeActivationFeeVerification(campaign.id, txid, 'verified', {
        payerAddress,
        treasuryAddressUsed: treasuryAddress,
      });
    } else {
      await service.finalizeActivationFeeVerification(campaign.id, txid, 'pending_verification', {
        payerAddress,
        treasuryAddressUsed: treasuryAddress,
      });
    }

    const updated = (await service.getCampaign(campaign.id)) as CampaignApiRecord | null;
    if (!updated) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    const response = await toActivationResponse(
      campaign.id,
      updated,
      verification.status === 'pending_verification' ? verification.warning : undefined,
      txid,
    );
    if (verification.status === 'pending_verification') {
      return res.json({
        ...response,
        message: 'Tx transmitida. Esperando confirmación on-chain.',
      });
    }
    return res.json(response);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

router.post('/campaign/:id/activation/confirm', confirmActivationHandler);
router.post('/campaigns/:id/activation/confirm', confirmActivationHandler);

export const activationStatusHandler: Parameters<typeof router.get>[1] = async (req, res) => {
  try {
    const campaign = await getCampaignOr404(req, res);
    if (!campaign) return;

    let verificationStatus = campaign.activationFeeVerificationStatus ?? 'none';
    let warning: string | undefined;
    const feeTxid = campaign.activationFeeTxid ?? campaign.activation?.feeTxid ?? null;
    if (feeTxid && verificationStatus === 'pending_verification') {
      const activationFeeRequiredTokenAmount = BigInt(ACTIVATION_FEE_TOKEN_AMOUNT_RAW);
      const treasuryAddress =
        campaign.activationTreasuryAddressUsed
        || campaign.treasuryAddressUsed
        || TREASURY_ADDRESS;
      const verification = await verifyActivationTxBestEffort(feeTxid, treasuryAddress, activationFeeRequiredTokenAmount);
      if (process.env.NODE_ENV !== 'production') {
        console.debug('[activation] status', {
          id: campaign.id,
          txid: feeTxid,
          result: verification.status,
          confs: verification.confirmations,
          treasuryOk: verification.treasuryOk,
          dustOk: verification.dustOk,
          tokenOk: verification.tokenOk,
          amountOk: verification.amountOk,
        });
      }
      if (verification.status === 'verified') {
        await service.finalizeActivationFeeVerification(campaign.id, feeTxid, 'verified', {
          treasuryAddressUsed: treasuryAddress,
        });
        verificationStatus = 'verified';
      } else if (verification.status === 'invalid') {
        await service.finalizeActivationFeeVerification(campaign.id, feeTxid, 'invalid', {
          treasuryAddressUsed: treasuryAddress,
          reason: verification.error,
        });
        verificationStatus = 'invalid';
      } else {
        warning = verification.warning;
      }
    }

    const refreshed = (await service.getCampaign(campaign.id)) as CampaignApiRecord | null;
    if (!refreshed) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    const response = await toActivationResponse(refreshed.id, refreshed, warning, feeTxid ?? undefined);
    return res.json(response);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

router.get('/campaigns/:id/activation/status', activationStatusHandler);
router.get('/campaign/:id/activation/status', activationStatusHandler);

const finalizeCampaignHandler: Parameters<typeof router.post>[1] = async (req, res) => {
  let campaign: CampaignApiRecord | null = null;
  try {
    const campaignId = validateCampaignIdParam(req.params.id);
    campaign = await getCampaignOr404(req, res);
    if (!campaign) return;

    if (!isActivationFeePaid(campaign)) {
      return res.status(400).json({
        error: 'validation-error',
        message: 'activation-fee-unpaid',
      });
    }

    const goalSats = coerceAmountToSats(campaign.goal);
    const beneficiaryAddress = resolveCampaignBeneficiaryAddress(campaign);
    const payoutTxid = campaign.payout?.txid ?? null;

    const forceRescueId = process.env.FORCE_RESCUE_CAMPAIGN_ID?.trim();

if ((campaign.status === 'paid_out' || payoutTxid) && forceRescueId !== campaignId) {
  console.info('[payout] idempotent-hit', {
    campaignId,
    goalSats: goalSats.toString(),
    raisedSats: '0',
    status: campaign.status,
    txid: payoutTxid,
  });

  return res.json({
    success: true,
    campaignId,
    status: 'paid_out',
    txid: payoutTxid,
    beneficiaryAddress,
    goalSats: goalSats.toString(),
    raisedSats: '0',
    message: 'Payout ya procesado previamente.',
  });
}

if ((campaign.status === 'paid_out' || payoutTxid) && forceRescueId === campaignId) {
  console.info('[force-rescue] route bypassing historical payout marker', {
    campaignId,
    historicalTxid: payoutTxid,
  });
}

    const result = await finalizeService.finalizeCampaign(campaignId);
    console.info('[payout] finalize-request', {
      campaignId,
      goalSats: result.goalSats.toString(),
      raisedSats: result.raisedSats.toString(),
      status: result.status,
      txid: result.txid,
    });

    return res.json({
      success: true,
      campaignId,
      status: result.status,
      txid: result.txid,
      beneficiaryAddress,
      goalSats: result.goalSats.toString(),
      raisedSats: result.raisedSats.toString(),
      message: 'Payout enviado.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[payout] failed', {
      campaignId: String(req.params.id ?? '').trim(),
      goalSats: campaign ? coerceAmountToSats(campaign.goal).toString() : '0',
      raisedSats: '0',
      status: campaign?.status ?? 'unknown',
      txid: campaign?.payout?.txid ?? null,
      error: message,
    });
    if (message === 'auto-payout-spend-path-missing') {
      return res.status(409).json({
        error: 'auto-payout-spend-path-missing',
        message: 'El covenant actual no tiene implementado el spend path backend-side para payout.',
      });
    }
    if (message === 'goal-not-reached') {
      return res.status(400).json({
        error: 'goal-not-reached',
        message: 'La meta on-chain aún no se ha alcanzado.',
      });
    }
    if (isValidationError(message)) {
      return res.status(400).json({
        error: 'validation-error',
        message,
      });
    }
    return res.status(500).json({
      error: 'internal-error',
      message,
    });
  }
};

router.post('/campaigns/:id/finalize-request', finalizeCampaignHandler);
router.post('/campaign/:id/finalize-request', finalizeCampaignHandler);
router.post('/campaigns/:id/payout/build', finalizeCampaignHandler);

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
  const campaignId = String(req.params.id ?? '').trim();
  if (!campaignId || campaignId === 'undefined') {
    return res.status(200).json([]);
  }

  try {
    const pledges = await getPledgesByCampaign(campaignId);
    return res.status(200).json(pledges.map((pledge) => ({
      pledgeId: pledge.pledgeId,
      txid: pledge.txid,
      wcOfferId: pledge.wcOfferId ?? null,
      contributorAddress: pledge.contributorAddress,
      amount: pledge.amount,
      timestamp: pledge.timestamp,
      message: pledge.message,
    })));
  } catch (err) {
    // TODO: return a typed error response once frontend flow can tolerate non-200 replies.
    console.error('[campaigns/:id/pledges] failed to fetch pledges', {
      campaignId,
      error: (err as Error).message,
    });
    return res.status(200).json([]);
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
