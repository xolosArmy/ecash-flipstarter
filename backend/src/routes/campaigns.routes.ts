import { Router } from 'express';
import { CampaignService } from '../services/CampaignService';
import { validateAddress } from '../utils/validation';
import { getPledgesByCampaign } from '../store/simplePledges';
import {
  addressToScriptPubKey,
  getTransactionInfo,
  getUtxosForAddress,
  isSpendableXecUtxo,
  ChronikUnavailableError,
  getEffectiveChronikBaseUrl,
  normalizeChronikAddress,
} from '../blockchain/ecashClient';
import type { Utxo } from '../blockchain/types';
import { buildPayoutTx } from '../blockchain/txBuilder';
import { serializeBuiltTx } from './serialize';
import { walletConnectOfferStore } from '../services/WalletConnectOfferStore';
import { ACTIVATION_FEE_SATS, ACTIVATION_FEE_XEC, TREASURY_ADDRESS } from '../config/constants';
import { saveCampaignsToDisk, type StoredCampaign } from '../store/campaignPersistence';
import { upsertCampaign as sqliteUpsertCampaign } from '../db/SQLiteStore';
import { syncCampaignStoreFromDiskCampaigns } from '../services/CampaignService';
import { buildEscrowMismatchDetails, repairCampaignEscrowAddress, validateEscrowConsistency } from '../services/escrowAddress';

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
  escrowAddress?: string;
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

function resolveCampaignBeneficiaryAddress(campaign: CampaignApiRecord): string {
  const beneficiaryAddress = campaign.beneficiaryAddress || campaign.recipientAddress;
  return validateAddress(beneficiaryAddress || '', 'beneficiaryAddress');
}

async function selectCampaignFundingUtxos(
  campaign: CampaignApiRecord,
  feeSats: bigint,
): Promise<{ escrowAddress: string; utxos: Utxo[]; total: bigint }> {
  const escrowValidation = validateEscrowConsistency(campaign);
  if (!escrowValidation.ok) {
    const mismatch = escrowValidation.details;
    throw Object.assign(new Error('escrow-address-mismatch'), { mismatch });
  }
  const escrowAddress = escrowValidation.escrowAddress;
  const utxos = (await getUtxosForAddress(escrowAddress)).filter(isSpendableXecUtxo);
  const total = utxos.reduce((acc, utxo) => acc + utxo.value, 0n);
  const normalizedAddress = normalizeChronikAddress(escrowAddress);
  console.log(`[PAYOUT-BUILD-DEBUG] campaignId=${campaign.id} escrowAddress=${escrowAddress}`);
  console.log(`[PAYOUT-BUILD-DEBUG] chronikUrl=${getEffectiveChronikBaseUrl()} chronikPath=/address/${normalizedAddress}/utxos`);
  console.log(
    `[PAYOUT-BUILD-DEBUG] campaignId=${campaign.id} raisedSats=${total.toString()} utxoCount=${utxos.length} goal=${String(campaign.goal)}`,
  );
  return { escrowAddress, utxos, total };
}

async function deriveScriptHashFromAddress(address?: string | null): Promise<string | null> {
  if (!address) return null;
  try {
    const scriptPubKey = await addressToScriptPubKey(address);
    const normalized = scriptPubKey.toLowerCase();
    if (normalized.startsWith('a914') && normalized.endsWith('87') && normalized.length === 46) {
      return normalized.slice(4, -2);
    }
    return null;
  } catch {
    return null;
  }
}

function logPayoutBuildErrorContext(args: {
  campaign: CampaignApiRecord;
  canonicalId: string;
  totalPledged?: bigint;
  derivedEscrowAddress?: string | null;
  derivedScriptHash?: string | null;
  error: string;
}) {
  console.error('[payout/build]', {
    campaignId: args.campaign.id,
    canonicalId: args.canonicalId,
    status: args.campaign.status,
    goalSats: args.campaign.goal,
    totalPledged: args.totalPledged?.toString(),
    derivedEscrowAddress: args.derivedEscrowAddress ?? null,
    derivedScriptHash: args.derivedScriptHash ?? null,
    error: args.error,
  });
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

export const createCampaignHandler: Parameters<typeof router.post>[1] = async (req, res) => {
  try {
    if (typeof req.body?.beneficiaryAddress === 'string' && req.body.beneficiaryAddress.trim()) {
      req.body.beneficiaryAddress = validateAddress(req.body.beneficiaryAddress, 'beneficiaryAddress');
    }

    const campaign = await service.createCampaign({
      ...(req.body ?? {}),
      id: undefined,
    });

    // Return canonical, persisted campaign payload (including public slug when available).
    return res.status(201).json(campaign);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

router.post('/campaign', createCampaignHandler);

router.post('/campaigns', createCampaignHandler);

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
    const { campaign } = resolvedCampaign;

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
    const { campaign } = resolvedCampaign;

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

export const buildCampaignPayoutHandler: Parameters<typeof router.post>[1] = async (req, res) => {
  let campaignContext: CampaignApiRecord | null = null;
  let canonicalIdContext: string | null = null;
  let totalPledgedContext: bigint | undefined;
  let derivedEscrowAddressContext: string | null = null;
  let derivedScriptHashContext: string | null = null;
  try {
    const requestedId = req.params.id;
    const resolvedCampaign = await resolveCampaignOr404(req, res);
    if (!resolvedCampaign) return;
    const { campaign, canonicalId } = resolvedCampaign;
    campaignContext = campaign;
    canonicalIdContext = canonicalId;

    if (campaign.status === 'funded' || campaign.status === 'paid_out') {
      logPayoutBuildErrorContext({ campaign, canonicalId, error: 'payout-already-processed' });
      return res.status(400).json({ error: 'payout-already-processed' });
    }

    if (process.env.NODE_ENV !== 'production') {
      console.debug(`[campaign] slug=${requestedId} canonicalId=${canonicalId}`);
    }

    const destinationBeneficiary =
      typeof req.body?.destinationBeneficiary === 'string' && req.body.destinationBeneficiary.trim()
        ? validateAddress(req.body.destinationBeneficiary, 'destinationBeneficiary')
        : resolveCampaignBeneficiaryAddress(campaign);

    let selectedFunding: Awaited<ReturnType<typeof selectCampaignFundingUtxos>>;
    try {
      selectedFunding = await selectCampaignFundingUtxos(campaign, PLEDGE_FEE_SATS);
    } catch (err) {
      if (err instanceof ChronikUnavailableError) {
        return res.status(503).json({
          error: 'chronik-unavailable',
          details: err.message,
        });
      }
      throw err;
    }

    const { escrowAddress, utxos: campaignUtxos, total } = selectedFunding;
    totalPledgedContext = total;
    derivedEscrowAddressContext = escrowAddress;
    derivedScriptHashContext = await deriveScriptHashFromAddress(escrowAddress);
    const goalSats = BigInt(campaign.goal);

    console.log('[PAYOUT]', {
      campaignId: canonicalId,
      escrowAddress,
      raisedSats: total.toString(),
      goal: campaign.goal,
    });

    if (total < goalSats) {
      logPayoutBuildErrorContext({
        campaign,
        canonicalId,
        totalPledged: total,
        derivedEscrowAddress: escrowAddress,
        derivedScriptHash: derivedScriptHashContext,
        error: 'insufficient-funds',
      });
      return res.status(400).json({
        error: 'insufficient-funds',
        details: {
          requiredSats: goalSats.toString(),
          availableSats: total.toString(),
          derivedEscrowAddress: escrowAddress,
          derivedScriptHash: derivedScriptHashContext,
        },
      });
    }

    const builtTx = await buildPayoutTx({
      campaignUtxos,
      totalRaised: total,
      beneficiaryAddress: destinationBeneficiary,
      treasuryAddress: TREASURY_ADDRESS,
      fixedFee: PLEDGE_FEE_SATS,
      dustLimit: 546n,
    });

    const built = serializeBuiltTx(builtTx);
    const offer = walletConnectOfferStore.createOffer({
      campaignId: canonicalId,
      unsignedTxHex: built.unsignedTxHex || built.rawHex,
      amount: total.toString(),
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

    await service.setPayoutOffer(canonicalId, offer.offerId);

    return res.json({
      unsignedTxHex: built.unsignedTxHex || built.rawHex,
      beneficiaryAmount: builtTx.beneficiaryAmount.toString(),
      treasuryCut: builtTx.treasuryCut.toString(),
      escrowAddress,
      wcOfferId: offer.offerId,
      raised: total.toString(),
    });
  } catch (err) {
    console.error('[payout/build] Fatal error:', err);
    const message = err instanceof Error ? err.message : String(err);
    const mismatch = (err as Error & { mismatch?: unknown }).mismatch as ReturnType<typeof buildEscrowMismatchDetails> | undefined;
    if (campaignContext && canonicalIdContext) {
      logPayoutBuildErrorContext({
        campaign: campaignContext,
        canonicalId: canonicalIdContext,
        totalPledged: totalPledgedContext,
        derivedEscrowAddress: derivedEscrowAddressContext,
        derivedScriptHash: derivedScriptHashContext,
        error: mismatch ? 'escrow-address-mismatch' : 'payout-build-failed',
      });
    }
    if (mismatch) {
      return res.status(400).json({ error: 'escrow-address-mismatch', ...mismatch });
    }
    if (err instanceof ChronikUnavailableError) {
      console.log(
        `[PAYOUT-BUILD-DEBUG] campaignId=${canonicalIdContext ?? 'unknown'} escrowAddress=${derivedEscrowAddressContext ?? 'unknown'} chronikUrl=${err.details.url} status=${String(err.details.status ?? 'unknown')} contentType=${err.details.contentType ?? 'unknown'}`,
      );
      return res.status(503).json({
        error: 'chronik-unavailable',
        details: {
          chronikUrl: err.details.url,
          status: err.details.status ?? null,
          contentType: err.details.contentType ?? null,
          bodyPreviewHex: err.details.bodyPreviewHex ?? null,
          campaignId: canonicalIdContext ?? null,
          escrowAddress: derivedEscrowAddressContext ?? null,
          note: 'Chronik respondió protobuf o no-JSON; no se pudo calcular raisedSats',
        },
      });
    }
    if (message.includes('destinationBeneficiary') || message.includes('beneficiaryAddress')) {
      return res.status(400).json({ error: 'payout-build-failed', details: { message } });
    }
    return res.status(400).json({ error: 'payout-build-failed', details: { message } });
  }
};

router.post('/campaigns/:id/payout/build', buildCampaignPayoutHandler);

router.post('/campaigns/:id/repair-escrow', async (req, res) => {
  try {
    const token = String(req.headers['x-admin-token'] ?? req.body?.adminToken ?? '').trim();
    const expected = String(process.env.ADMIN_TOKEN ?? process.env.CAMPAIGN_ADMIN_TOKEN ?? '').trim();
    if (!expected || token !== expected) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const resolvedCampaign = await resolveCampaignOr404(req, res);
    if (!resolvedCampaign) return;
    const storedCampaign = toStoredCampaignRecord(resolvedCampaign.campaign);
    const before = {
      escrowAddress: storedCampaign.escrowAddress ?? null,
      covenantAddress: storedCampaign.covenantAddress ?? null,
      campaignAddress: storedCampaign.campaignAddress ?? null,
      recipientAddress: storedCampaign.recipientAddress ?? null,
    };
    const repaired = await repairCampaignEscrowAddress(storedCampaign);
    resolvedCampaign.campaign.escrowAddress = repaired.escrowAddress;
    resolvedCampaign.campaign.campaignAddress = repaired.escrowAddress;
    resolvedCampaign.campaign.covenantAddress = repaired.escrowAddress;
    resolvedCampaign.campaign.recipientAddress = repaired.escrowAddress;
    await sqliteUpsertCampaign(storedCampaign);
    const campaigns = (await service.listCampaigns()) as StoredCampaign[];
    syncCampaignStoreFromDiskCampaigns(campaigns);
    await saveCampaignsToDisk(campaigns);
    return res.json({
      ok: true,
      campaignId: resolvedCampaign.canonicalId,
      before,
      after: {
        escrowAddress: repaired.escrowAddress,
        covenantAddress: repaired.escrowAddress,
        campaignAddress: repaired.escrowAddress,
        recipientAddress: repaired.escrowAddress,
      },
      txidUsed: repaired.txidUsed,
      source: repaired.source,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

export const confirmCampaignPayoutHandler: Parameters<typeof router.post>[1] = async (req, res) => {
  try {
    const resolvedCampaign = await resolveCampaignOr404(req, res);
    if (!resolvedCampaign) return;
    const { campaign } = resolvedCampaign;

    const txid = sanitizeTxid(req.body?.txid);

    if (campaign.status !== 'funded') {
      return res.status(400).json({ error: 'payout-not-allowed' });
    }

    await service.markPayoutComplete(campaign.id, txid, TREASURY_ADDRESS);

    const updated = (await service.getCampaign(campaign.id)) as CampaignApiRecord | null;
    if (!updated) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }

    await sqliteUpsertCampaign(toStoredCampaignRecord(updated));

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
};

router.post('/campaigns/:id/payout/confirm', confirmCampaignPayoutHandler);

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
