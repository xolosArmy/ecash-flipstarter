import { Router } from 'express';
import { CampaignService } from '../services/CampaignService';
import { validateAddress } from '../utils/validation';
import { getPledgesByCampaign } from '../store/simplePledges';
import { addressToScriptPubKey, getTransactionInfo, getUtxosForAddress } from '../blockchain/ecashClient';
import { buildPayoutTx } from '../blockchain/txBuilder';
import { serializeBuiltTx } from './serialize';
import { walletConnectOfferStore } from '../services/WalletConnectOfferStore';
import { ACTIVATION_FEE_SATS, ACTIVATION_FEE_XEC, TREASURY_ADDRESS } from '../config/constants';
import { saveCampaignsToDisk, type StoredCampaign } from '../store/campaignPersistence';
import { upsertCampaign as sqliteUpsertCampaign } from '../db/SQLiteStore';
import { syncCampaignStoreFromDiskCampaigns } from '../services/CampaignService';

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
  activationOfferOutputs?: Array<{ address: string; valueSats: number }> | null;
  activationTreasuryAddressUsed?: string | null;
  payout?: {
    wcOfferId?: string | null;
    txid?: string | null;
    paidAt?: string | null;
  };
  treasuryAddressUsed?: string | null;
};

const TXID_HEX_REGEX = /^[0-9a-f]{64}$/i;
const PLEDGE_FEE_SATS = 500n;

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
    amountOk: true;
  }
  | {
    status: 'pending_verification';
    warning: string;
    confirmations: number;
    treasuryOk: boolean;
    amountOk: boolean;
  }
  | {
    status: 'invalid';
    error: string;
    confirmations: number;
    treasuryOk: boolean;
    amountOk: boolean;
  };

async function verifyActivationTxBestEffort(
  txid: string,
  treasuryAddress: string,
  activationFeeRequiredSats: bigint,
): Promise<VerificationResult> {
  try {
    const treasuryScript = (await addressToScriptPubKey(treasuryAddress)).toLowerCase();
    const tx = await getTransactionInfo(txid);
    const treasuryOutputs = tx.outputs.filter(
      (output) => output.scriptPubKey.toLowerCase() === treasuryScript,
    );
    const treasuryOk = treasuryOutputs.length > 0;
    const amountOk = treasuryOutputs.some((output) => output.valueSats >= activationFeeRequiredSats);
    const confirmations = Math.max(
      Number.isFinite(tx.confirmations) ? Math.floor(tx.confirmations) : 0,
      tx.height >= 0 ? 1 : 0,
    );
    if (!treasuryOk || !amountOk) {
      return {
        status: 'invalid',
        error: 'activation-fee-output-mismatch',
        confirmations,
        treasuryOk,
        amountOk,
      };
    }
    if (confirmations < 1) {
      return {
        status: 'pending_verification',
        warning: 'activation-fee-unconfirmed',
        confirmations,
        treasuryOk,
        amountOk,
      };
    }
    return { status: 'verified', confirmations, treasuryOk: true, amountOk: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[activation] chronik unavailable', { txid, message });
    return {
      status: 'pending_verification',
      warning: 'chronik-unavailable',
      confirmations: 0,
      treasuryOk: false,
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

function resolveCampaignBeneficiaryAddress(campaign: CampaignApiRecord): string {
  const beneficiaryAddress = campaign.beneficiaryAddress || campaign.recipientAddress;
  return validateAddress(beneficiaryAddress || '', 'beneficiaryAddress');
}

async function selectCampaignFundingUtxos(
  campaign: CampaignApiRecord,
  minimumRaisedSats: bigint,
  feeSats: bigint,
) {
  const escrowAddress = resolveCampaignEscrowAddress(campaign);
  const campaignUtxos = (await getUtxosForAddress(escrowAddress)).filter(
    (utxo) => !utxo.token && !utxo.slpToken && !utxo.tokenStatus && !utxo.plugins?.token,
  );
  const total = campaignUtxos.reduce((acc, utxo) => acc + utxo.value, 0n);
  if (total < minimumRaisedSats + feeSats) {
    throw new Error('insufficient-funds');
  }
  return { escrowAddress, campaignUtxos };
}

function toStoredCampaignRecord(campaign: CampaignApiRecord): StoredCampaign {
  const expirationMs = Number(campaign.expirationTime);
  const fallbackExpiry = Number.isFinite(expirationMs) ? new Date(expirationMs).toISOString() : new Date(0).toISOString();
  return {
    ...(campaign as unknown as StoredCampaign),
    goal: campaign.goal,
    expiresAt: (campaign as unknown as { expiresAt?: string }).expiresAt ?? fallbackExpiry,
    createdAt: (campaign as unknown as { createdAt?: string }).createdAt ?? new Date().toISOString(),
  };
}

async function resolveCampaignOr404(req: any, res: any): Promise<{ canonicalId: string; campaign: CampaignApiRecord } | null> {
  const resolved = await service.getCanonicalCampaign(req.params.id);
  if (!resolved) {
    res.status(404).json({ error: 'campaign-not-found' });
    return null;
  }
  req.params.id = resolved.canonicalId;
  return { canonicalId: resolved.canonicalId, campaign: resolved.campaign as CampaignApiRecord };
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
    const resolved = await service.getCanonicalCampaign(req.params.id);
    if (!resolved) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    return res.json({ ...resolved.campaign, canonicalId: resolved.canonicalId });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/campaigns/:id', async (req, res) => {
  try {
    const resolved = await service.getCanonicalCampaign(req.params.id);
    if (!resolved) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    return res.json({ ...resolved.campaign, canonicalId: resolved.canonicalId });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

const createCampaign: Parameters<typeof router.post>[1] = async (req, res) => {
  try {
    if (typeof req.body?.beneficiaryAddress === 'string' && req.body.beneficiaryAddress.trim()) {
      req.body.beneficiaryAddress = validateAddress(req.body.beneficiaryAddress, 'beneficiaryAddress');
    }

    // Server-side source of truth for campaign IDs.
    const serverGeneratedId = `campaign-${Date.now()}`;
    const campaign = await service.createCampaign({
      ...(req.body ?? {}),
      id: serverGeneratedId,
    });

    // Return canonical campaign payload (including the server-generated ID).
    return res.status(201).json(campaign);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

router.post('/campaign', createCampaign);

router.post('/campaigns', createCampaign);

// Legacy endpoint: only allows ACTIVE when fee is paid.
async function activateCampaign(req: any, res: any) {
  try {
    const resolvedCampaign = await resolveCampaignOr404(req, res);
    if (!resolvedCampaign) return;
    const { canonicalId } = resolvedCampaign;
    await service.updateCampaignStatus(canonicalId, 'active');
    return res.json({ success: true, status: 'active', canonicalId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'activation-fee-unpaid') {
      return res.status(400).json({ error: 'activation-fee-unpaid' });
    }
    return res.status(500).json({ error: 'Failed to activate campaign' });
  }
}

async function processCampaignPayout(req: any, res: any) {
  try {
    const resolvedCampaign = await resolveCampaignOr404(req, res);
    if (!resolvedCampaign) return;
    const { canonicalId } = resolvedCampaign;
    await service.updateCampaignStatus(canonicalId, 'funded');
    return res.json({ success: true, status: 'funded', canonicalId });
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
    const resolvedCampaign = await resolveCampaignOr404(req, res);
    if (!resolvedCampaign) return;
    const { campaign, canonicalId } = resolvedCampaign;

    if (isActivationFeePaid(campaign)) {
      return res.status(400).json({ error: 'activation-fee-already-paid' });
    }

    const payerAddress = validateAddress(req.body?.payerAddress as string, 'payerAddress');
    const activationFeeRequired = toCampaignActivationFeeRequired(campaign);
    const amount = BigInt(activationFeeRequired * 100);
    const activationFeeTxid = getActivationFeeTxid(campaign);
    const persistedOutputs =
      Array.isArray(campaign.activationOfferOutputs) && campaign.activationOfferOutputs.length > 0
        ? campaign.activationOfferOutputs
        : null;
    const treasuryAddress = campaign.activationTreasuryAddressUsed || TREASURY_ADDRESS;
    const outputs = persistedOutputs ?? [{ address: treasuryAddress, valueSats: Number(amount) }];
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
    const resolvedCampaign = await resolveCampaignOr404(req, res);
    if (!resolvedCampaign) return;
    const { campaign, canonicalId } = resolvedCampaign;

    const txid = sanitizeTxid(req.body?.txid);
    const payerAddress =
      typeof req.body?.payerAddress === 'string' && req.body.payerAddress.trim()
        ? validateAddress(req.body.payerAddress, 'payerAddress')
        : null;
    const activationFeeRequiredSats = BigInt(toCampaignActivationFeeRequired(campaign) * 100);
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
      return res.json(await toActivationResponse(canonicalId, campaign, undefined, txid));
    }

    await service.recordActivationFeeBroadcast(campaign.id, txid, {
      paidAt: new Date().toISOString(),
      payerAddress,
      treasuryAddressUsed: treasuryAddress,
    });

    const verification = await verifyActivationTxBestEffort(txid, treasuryAddress, activationFeeRequiredSats);
    if (process.env.NODE_ENV !== 'production') {
      console.debug('[activation] confirm', {
        id: campaign.id,
        txid,
        result: verification.status,
        confs: verification.confirmations,
        treasuryOk: verification.treasuryOk,
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
        ...(await toActivationResponse(canonicalId, updatedInvalid, verification.error, txid)),
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
      canonicalId,
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
    const resolvedCampaign = await resolveCampaignOr404(req, res);
    if (!resolvedCampaign) return;
    const { campaign, canonicalId } = resolvedCampaign;

    let verificationStatus = campaign.activationFeeVerificationStatus ?? 'none';
    let warning: string | undefined;
    const feeTxid = campaign.activationFeeTxid ?? campaign.activation?.feeTxid ?? null;
    if (feeTxid && verificationStatus === 'pending_verification') {
      const activationFeeRequiredSats = BigInt(toCampaignActivationFeeRequired(campaign) * 100);
      const treasuryAddress =
        campaign.activationTreasuryAddressUsed
        || campaign.treasuryAddressUsed
        || TREASURY_ADDRESS;
      const verification = await verifyActivationTxBestEffort(feeTxid, treasuryAddress, activationFeeRequiredSats);
      if (process.env.NODE_ENV !== 'production') {
        console.debug('[activation] status', {
          id: campaign.id,
          txid: feeTxid,
          result: verification.status,
          confs: verification.confirmations,
          treasuryOk: verification.treasuryOk,
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
    const response = await toActivationResponse(canonicalId, refreshed, warning, feeTxid ?? undefined);
    return res.json(response);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

router.get('/campaigns/:id/activation/status', activationStatusHandler);
router.get('/campaign/:id/activation/status', activationStatusHandler);

const buildCampaignPayoutHandler: Parameters<typeof router.post>[1] = async (req, res) => {
  try {
    const requestedId = req.params.id;
    const resolvedCampaign = await resolveCampaignOr404(req, res);
    if (!resolvedCampaign) return;
    const { campaign, canonicalId } = resolvedCampaign;

    if (process.env.NODE_ENV !== 'production') {
      console.debug(`[campaign] slug=${requestedId} canonicalId=${canonicalId}`);
    }

    const destinationBeneficiary =
      typeof req.body?.destinationBeneficiary === 'string' && req.body.destinationBeneficiary.trim()
        ? validateAddress(req.body.destinationBeneficiary, 'destinationBeneficiary')
        : resolveCampaignBeneficiaryAddress(campaign);

    const { escrowAddress, campaignUtxos } = await selectCampaignFundingUtxos(campaign, 0n, PLEDGE_FEE_SATS);
    const raisedSats = campaignUtxos.reduce((acc, utxo) => acc + utxo.value, 0n);

    console.log(
      `[payout/build] Campaña: ${canonicalId} (requested: ${requestedId}) | Escrow: ${escrowAddress} | Total On-Chain: ${raisedSats} | Meta: ${campaign.goal}`,
    );

    if (raisedSats < BigInt(campaign.goal)) {
      return res.status(400).json({
        error: 'insufficient-funds',
        details: 'La meta en cadena aún no se ha alcanzado.',
        escrowAddress,
        goal: campaign.goal.toString(),
        raised: raisedSats.toString(),
        utxoCount: campaignUtxos.length,
      });
    }

    const builtTx = await buildPayoutTx({
      campaignUtxos,
      totalRaised: raisedSats,
      beneficiaryAddress: destinationBeneficiary,
      treasuryAddress: TREASURY_ADDRESS,
      fixedFee: PLEDGE_FEE_SATS,
      dustLimit: 546n,
    });

    const built = serializeBuiltTx(builtTx);
    const offer = walletConnectOfferStore.createOffer({
      campaignId: canonicalId,
      unsignedTxHex: built.unsignedTxHex || built.rawHex,
      amount: raisedSats.toString(),
      contributorAddress: destinationBeneficiary,
    });

    campaign.status = 'funded';
    try {
      const storedCampaign = toStoredCampaignRecord(campaign);
      await sqliteUpsertCampaign(storedCampaign);
      const campaigns = (await service.listCampaigns()) as StoredCampaign[];
      syncCampaignStoreFromDiskCampaigns(campaigns);
      await saveCampaignsToDisk(campaigns);
      console.log(`[payout/build] Estado de campaña ${canonicalId} actualizado a 'funded' exitosamente.`);
    } catch (persistErr) {
      console.error('[payout/build] Error actualizando SQLite/JSON:', persistErr);
    }

    await service.setPayoutOffer(campaign.id, offer.offerId);

    return res.json({
      unsignedTxHex: built.unsignedTxHex || built.rawHex,
      beneficiaryAmount: builtTx.beneficiaryAmount.toString(),
      treasuryCut: builtTx.treasuryCut.toString(),
      escrowAddress,
      wcOfferId: offer.offerId,
      raised: raisedSats.toString(),
    });
  } catch (err) {
    console.error('[payout/build] Fatal error:', err);
    const message = err instanceof Error ? err.message : String(err);
    const statusCode = message.includes('address') || message.includes('funds') ? 400 : 500;
    return res.status(statusCode).json({ error: 'payout-build-failed', message });
  }
};

router.post('/campaigns/:id/payout/build', buildCampaignPayoutHandler);

router.post('/campaigns/:id/payout/confirm', async (req, res) => {
  try {
    const resolvedCampaign = await resolveCampaignOr404(req, res);
    if (!resolvedCampaign) return;
    const { campaign, canonicalId } = resolvedCampaign;

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
    const resolved = await service.getCanonicalCampaign(req.params.id);
    if (!resolved) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const pledges = await getPledgesByCampaign(resolved.canonicalId);
    const totalPledged = pledges.reduce((total, pledge) => total + pledge.amount, 0);
    return res.json({
      totalPledged,
      pledgeCount: pledges.length,
      canonicalId: resolved.canonicalId,
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
    const resolved = await service.getCanonicalCampaign(req.params.id);
    if (!resolved) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const pledges = await getPledgesByCampaign(resolved.canonicalId);
    const totalPledged = pledges.reduce((total, pledge) => total + pledge.amount, 0);
    const summary = toSummary(resolved.campaign as CampaignApiRecord, totalPledged);

    return res.json({
      ...summary,
      pledgeCount: pledges.length,
      canonicalId: resolved.canonicalId,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/campaign/:id/history', async (req, res) => {
  try {
    const resolved = await service.getCanonicalCampaign(req.params.id);
    if (!resolved) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const history = await service.getCampaignHistory(resolved.canonicalId);
    return res.json(history);
  } catch (_error) {
    return res.status(500).json({ error: 'Failed to fetch campaign history' });
  }
});

router.get('/campaigns/:id/history', async (req, res) => {
  try {
    const resolved = await service.getCanonicalCampaign(req.params.id);
    if (!resolved) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const history = await service.getCampaignHistory(resolved.canonicalId);
    return res.json(history);
  } catch (_error) {
    return res.status(500).json({ error: 'Failed to fetch campaign history' });
  }
});

export async function getCampaignStatusById(campaignIdOrSlug: string): Promise<CampaignStatus | null> {
  const canonicalId = await service.resolveCampaignId(campaignIdOrSlug);
  if (!canonicalId) {
    return null;
  }
  const campaign = (await service.getCampaign(canonicalId)) as CampaignApiRecord | null;
  if (!campaign) {
    return null;
  }
  const totalPledged = await getTotalPledged(canonicalId);
  return deriveCampaignStatus(campaign, totalPledged);
}

export default router;
