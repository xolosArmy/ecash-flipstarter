import { Router } from 'express';
import { CampaignService } from '../services/CampaignService';
import { PledgeService } from '../services/PledgeService';
import {
  ChronikUnavailableError,
  addressToScriptPubKey,
  getEffectiveChronikBaseUrl,
  getTransactionInfo,
  getUtxosForAddress,
  isSpendableXecUtxo,
} from '../blockchain/ecashClient';
import { buildPayoutTx } from '../blockchain/txBuilder';
import { serializeBuiltTx } from './serialize';
import { walletConnectOfferStore } from '../services/WalletConnectOfferStore';
import { TREASURY_ADDRESS } from '../config/constants';
import { getPledgesByCampaign } from '../store/simplePledges';
import { resolveEscrowAddress } from '../services/escrowAddress';
import { getCampaignById } from '../db/SQLiteStore';

const router = Router();
const service = new CampaignService();
const pledgeService = new PledgeService();

export const getCampaignStatusById = async (id: string) => {
  const resolved = await service.getCanonicalCampaign(id);
  return resolved?.campaign?.status;
};

// Estadísticas globales de todas las campañas
router.get('/stats', async (_req, res) => {
  try {
    const campaigns = await service.listCampaigns();
    const pledges = await pledgeService.listAllPledges();
    res.json({
      totalCampaigns: campaigns.length,
      totalRaisedSats: pledges.reduce((acc: number, p: any) => acc + (p.amount || 0), 0).toString(),
      activePledges: pledges.length,
    });
  } catch (_e) {
    res.json({ totalCampaigns: 0, totalRaisedSats: '0', activePledges: 0 });
  }
});

// Lista TODAS las campañas con sus detalles
router.get('/campaigns', async (_req, res) => {
  try {
    let camps = await service.listCampaigns();
    if (camps.length === 0) {
      await (require('../services/CampaignService').hydrateCampaignStore)();
      camps = await service.listCampaigns();
    }
    res.json(camps);
  } catch (_e) {
    res.json([]);
  }
});

export const createCampaignHandler = async (req: any, res: any) => {
  try {
    const { id: _ignoredId, ...payload } = (req.body ?? {}) as Record<string, unknown>;
    const created = await service.createCampaign(payload);
    return res.status(201).json(created);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

// Detalle de una campaña específica por ID o Slug
router.get('/campaigns/:id', async (req, res) => {
  try {
    const resolved = await service.getCanonicalCampaign(req.params.id);
    if (!resolved) return res.status(404).json({ error: 'not-found' });
    res.json(resolved.campaign);
  } catch (_e) {
    res.status(404).json({ error: 'error-fetching' });
  }
});

router.get('/campaigns/:id/summary', async (req, res) => {
  res.json(await pledgeService.getCampaignSummary(req.params.id));
});

// Historial formateado para el Frontend (AuditLog)
router.get('/campaigns/:id/history', async (req, res) => {
  try {
    const data = await pledgeService.listPledges(req.params.id);
    res.json(
      data.map((p: any) => ({
        id: p.pledgeId,
        type: 'pledge',
        timestamp: p.timestamp,
        payload: {
          contributorAddress: p.contributorAddress,
          amount: p.amount,
          txid: p.txid,
          message: p.message,
        },
      })),
    );
  } catch (_e) {
    res.json([]);
  }
});

export const buildActivationHandler = async (req: any, res: any) => {
  try {
    const campaign = await service.getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'not-found' });

    const payerAddress = req.body?.payerAddress || null;
    const outputs = campaign.activationOfferOutputs || [
      {
        address: TREASURY_ADDRESS,
        valueSats: Number(campaign.activationFeeRequired || 800000) * 100,
      },
    ];

    if (campaign.activationOfferMode === 'intent' && campaign.activation?.wcOfferId && campaign.activationOfferOutputs) {
      return res.json({
        mode: 'intent',
        outputs: campaign.activationOfferOutputs,
        wcOfferId: campaign.activation.wcOfferId,
      });
    }

    const offer = walletConnectOfferStore.createOffer({
      campaignId: campaign.id,
      unsignedTxHex: '',
      amount: String(outputs.reduce((sum: number, o: any) => sum + Number(o.valueSats || 0), 0)),
      contributorAddress: payerAddress,
    });

    await service.setActivationOffer(campaign.id, offer.offerId, payerAddress, {
      mode: 'intent',
      outputs,
      treasuryAddressUsed: TREASURY_ADDRESS,
      logAuditEvent: true,
    });

    return res.json({ mode: 'intent', outputs, wcOfferId: offer.offerId });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

export const confirmActivationHandler = async (req: any, res: any) => {
  try {
    const txid = String(req.body?.txid || '').trim().toLowerCase();
    const campaign = await service.getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'not-found' });
    if (!txid) return res.status(400).json({ error: 'txid-required' });

    if (campaign.activationFeeVerificationStatus === 'verified' && campaign.activationFeeTxid === txid) {
      return res.json({ status: campaign.status, activationFeePaid: true, verificationStatus: 'verified', txid });
    }

    await service.recordActivationFeeBroadcast(campaign.id, txid, {
      payerAddress: req.body?.payerAddress || null,
      treasuryAddressUsed: TREASURY_ADDRESS,
    });

    let outcome: 'verified' | 'invalid' | 'pending_verification' = 'pending_verification';
    let warning: string | undefined;

    try {
      const expectedScript = await addressToScriptPubKey(TREASURY_ADDRESS);
      const txInfo = await getTransactionInfo(txid);
      const requiredSats = BigInt(Number(campaign.activationFeeRequired || 800000) * 100);
      const hasFeeOutput = txInfo.outputs.some((o) => o.scriptPubKey === expectedScript && o.valueSats >= requiredSats);

      if (!hasFeeOutput) {
        outcome = 'invalid';
        warning = 'activation-fee-output-mismatch';
      } else if (txInfo.confirmations >= 1) {
        outcome = 'verified';
      }
    } catch (_err) {
      outcome = 'pending_verification';
      warning = 'chronik-unavailable';
    }

    await service.finalizeActivationFeeVerification(campaign.id, txid, outcome, {
      payerAddress: req.body?.payerAddress || null,
      treasuryAddressUsed: TREASURY_ADDRESS,
      reason: warning || null,
    });

    const updated = await service.getCampaign(campaign.id);
    return res.json({
      status: updated?.status || campaign.status,
      activationFeePaid: updated?.activationFeePaid || false,
      verificationStatus: updated?.activationFeeVerificationStatus || outcome,
      txid,
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

export const activationStatusHandler = async (req: any, res: any) => {
  try {
    const campaign = await service.getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'not-found' });

    const txid = campaign.activationFeeTxid;
    if (!txid) {
      return res.json({ status: campaign.status, verificationStatus: campaign.activationFeeVerificationStatus || 'none' });
    }

    const confirmReq = {
      ...req,
      params: { id: campaign.id },
      body: {
        txid,
        payerAddress: campaign.activation?.payerAddress || null,
      },
    };
    return confirmActivationHandler(confirmReq, res);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

export const buildCampaignPayoutHandler = async (req: any, res: any) => {
  try {
    const resolved = await service.getCanonicalCampaign(req.params.id);
    const campaign = resolved?.campaign;
    if (!campaign || !resolved) return res.status(404).json({ error: 'not-found' });

    let escrowAddress: string;
    try {
      escrowAddress = resolveEscrowAddress(campaign);
    } catch {
      return res.status(400).json({ error: 'missing-escrow-address' });
    }

    if (campaign.status === 'funded' || campaign.status === 'paid_out') {
      return res.status(400).json({ error: 'payout-already-processed' });
    }

    let utxos;
    try {
      utxos = await getUtxosForAddress(escrowAddress);
    } catch (err) {
      if (err instanceof ChronikUnavailableError) {
        return res.status(503).json({
          error: 'chronik-unavailable',
          details: {
            campaignId: resolved.canonicalId,
            escrowAddress,
            chronikUrl: getEffectiveChronikBaseUrl(),
            ...err.details,
          },
        });
      }
      throw err;
    }

    const campaignUtxos = utxos.filter((u: any) => isSpendableXecUtxo(u));
    const raisedSats = campaignUtxos.reduce((acc: bigint, u: any) => acc + BigInt(u.value || 0), 0n);
    const goalSats = BigInt(campaign.goal || 0);

    console.info('[PAYOUT_BUILD]', {
      campaignId: campaign.id,
      escrowAddressUsed: escrowAddress,
      goal: goalSats.toString(),
      raisedSats: raisedSats.toString(),
      utxoCount: campaignUtxos.length,
    });

    if (campaignUtxos.length === 0) {
      return res.status(400).json({
        error: 'chronik-address-utxos-not-found',
        details: {
          campaignId: campaign.id,
          escrowAddressUsed: escrowAddress,
          goal: goalSats.toString(),
          raisedSats: raisedSats.toString(),
          utxoCount: 0,
          chronikUrl: getEffectiveChronikBaseUrl(),
        },
      });
    }

    if (raisedSats < goalSats) {
      const missing = goalSats - raisedSats;
      return res.status(400).json({
        error: 'insufficient-funds-on-chain',
        details: {
          campaignId: campaign.id,
          escrowAddressUsed: escrowAddress,
          goal: goalSats.toString(),
          raisedSats: raisedSats.toString(),
          missingSats: missing.toString(),
          utxoCount: campaignUtxos.length,
        },
      });
    }

    const builtTx = await buildPayoutTx({
      campaignUtxos,
      totalRaised: raisedSats,
      beneficiaryAddress: campaign.beneficiaryAddress || '',
      treasuryAddress: TREASURY_ADDRESS,
      fixedFee: 500n,
      dustLimit: 546n,
    });
    const built = serializeBuiltTx(builtTx);
    const offer = walletConnectOfferStore.createOffer({
      campaignId: resolved.canonicalId,
      unsignedTxHex: built.unsignedTxHex || built.rawHex,
      amount: raisedSats.toString(),
      contributorAddress: campaign.beneficiaryAddress || '',
    });
    await service.setPayoutOffer(resolved.canonicalId, offer.offerId);
    return res.json({
      unsignedTxHex: built.unsignedTxHex || built.rawHex,
      wcOfferId: offer.offerId,
      raised: raisedSats.toString(),
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

async function getUtxosForAddressSafe(address?: string | null) {
  if (!address) return [];
  try {
    return await getUtxosForAddress(address);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes('address-utxos-not-found')
      || message.includes('utxos-not-found')
    ) {
      return [];
    }
    throw err;
  }
}

export const debugEscrowHandler = async (req: any, res: any) => {
  const campaignId = String(req.params.campaignId || req.params.id || '').trim();

  try {
    const campaign = await getCampaignById(campaignId);

    if (!campaign) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }

    const escrowAddressUsed = (() => {
      try {
        return resolveEscrowAddress(campaign);
      } catch {
        return campaign.escrowAddress || campaign.covenantAddress || campaign.campaignAddress || null;
      }
    })();
    const utxos = await getUtxosForAddressSafe(escrowAddressUsed);

    const raisedSats = utxos.reduce((sum, u) => {
      const candidate = u as { value?: unknown; sats?: unknown };
      return sum + Number(candidate.value || candidate.sats || 0);
    }, 0);

    return res.json({
      campaignId,
      recipientAddress: campaign.recipientAddress ?? null,
      beneficiaryAddress: campaign.beneficiaryAddress ?? null,
      campaignAddress: campaign.campaignAddress ?? null,
      covenantAddress: campaign.covenantAddress ?? null,
      escrowAddress: campaign.escrowAddress ?? null,
      escrowAddressUsed,
      chronikUrl: getEffectiveChronikBaseUrl(),
      utxosCount: utxos.length,
      raisedSats,
    });
  } catch (err) {
    console.error('[debug/escrow]', err);
    return res.status(200).json({
      campaignId,
      recipientAddress: null,
      beneficiaryAddress: null,
      campaignAddress: null,
      covenantAddress: null,
      escrowAddress: null,
      escrowAddressUsed: null,
      chronikUrl: getEffectiveChronikBaseUrl(),
      utxosCount: 0,
      raisedSats: 0,
      error: 'debug-escrow-failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

export const confirmCampaignPayoutHandler = async (req: any, res: any) => {
  try {
    const txid = String(req.body?.txid || '').trim().toLowerCase();
    const resolved = await service.getCanonicalCampaign(req.params.id);
    if (!resolved) return res.status(404).json({ error: 'not-found' });
    if (!txid) return res.status(400).json({ error: 'txid-required' });
    if (resolved.campaign.status !== 'funded') {
      return res.status(400).json({ error: 'payout-not-allowed' });
    }

    await service.markPayoutComplete(resolved.canonicalId, txid, TREASURY_ADDRESS);
    const updated = await service.getCampaign(resolved.canonicalId);
    const pledges = await getPledgesByCampaign(resolved.canonicalId);

    return res.json({
      ...(updated || { status: 'paid_out' }),
      pledgeCount: pledges.length,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

router.post('/campaigns', createCampaignHandler);
router.post('/campaigns/:id/activation/build', buildActivationHandler);
router.post('/campaigns/:id/activation/confirm', confirmActivationHandler);
router.get('/campaigns/:id/activation/status', activationStatusHandler);
router.post('/campaigns/:id/payout/build', buildCampaignPayoutHandler);
router.post('/campaigns/:id/payout/confirm', confirmCampaignPayoutHandler);
router.get('/debug/escrow/:campaignId', debugEscrowHandler);

export default router;
