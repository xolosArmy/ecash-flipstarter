import { Router } from 'express';
import { validateAddress } from '../utils/validation';
import { createWalletConnectPledgeOffer } from '../services/PledgeOfferService';
import { getCampaignStatusById } from './campaigns.routes';
import { CampaignService } from '../services/CampaignService';
import { parsePledgeAmountSats, parsePledgeMessage } from './pledgePayload';
import {
  getPledgeById,
  getPledgesByCampaign,
  updatePledgeVerification,
  type SimplePledge,
} from '../store/simplePledges';
import { PledgeVerificationService } from '../services/PledgeVerificationService';

const router = Router();
const campaignService = new CampaignService();
const pledgeVerificationService = new PledgeVerificationService();
const TXID_HEX_REGEX = /^[0-9a-fA-F]{64}$/;

export const createPledgeHandler = async (req: any, res: any) => {
  try {
    const status = await getCampaignStatusById(req.params.id);
    if (!status) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    if (status !== 'active') {
      return res.status(400).json({ error: 'campaign-not-active' });
    }
    const campaign = await campaignService.getCampaign(req.params.id) as
      | { campaignAddress?: string; covenantAddress?: string }
      | null;
    const campaignAddress = campaign?.campaignAddress || campaign?.covenantAddress || '';
    if (!campaignAddress) {
      return res.status(400).json({ error: 'campaign-address-required' });
    }

    const expectedAmountSats = parsePledgeAmountSats(req.body);
    const message = parsePledgeMessage(req.body);
    const contributorAddress = validateAddress(
      req.body.contributorAddress as string,
      'contributorAddress'
    );
    const response = await createWalletConnectPledgeOffer(req.params.id, contributorAddress, expectedAmountSats, {
      campaignAddress,
      message,
    });
    res.json(response);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
};

function sanitizeTxid(raw: unknown): string {
  const txid = String(raw ?? '').trim();
  if (!TXID_HEX_REGEX.test(txid)) {
    throw new Error('txid-invalid');
  }
  return txid.toLowerCase();
}

function selectPledgeToConfirm(pledges: SimplePledge[], body: Record<string, unknown>): SimplePledge | undefined {
  const pledgeId = body.pledgeId != null ? String(body.pledgeId).trim() : '';
  if (pledgeId) {
    return pledges.find((pledge) => pledge.pledgeId === pledgeId);
  }

  const wcOfferId = body.wcOfferId != null ? String(body.wcOfferId).trim() : '';
  if (wcOfferId) {
    return pledges.find((pledge) => String(pledge.wcOfferId) === String(wcOfferId));
  }

  return undefined;
}

function hasPledgeIdentity(body: Record<string, unknown>): boolean {
  return Boolean(
    (body.pledgeId != null && String(body.pledgeId).trim())
    || (body.wcOfferId != null && String(body.wcOfferId).trim()),
  );
}

function isTerminalPledge(pledge: SimplePledge): boolean {
  return pledge.status === 'confirmed' || pledge.status === 'finalized' || pledge.status === 'refunded';
}

function isConfirmablePledge(pledge: SimplePledge): boolean {
  return pledge.status === 'intent'
    || pledge.status === 'broadcasted'
    || pledge.status === 'pending_verification'
    || pledge.status === 'seen_mempool'
    || (pledge.status === 'invalid' && pledge.statusReason === 'txid-not-found');
}

function sendIdempotentPledgeSuccess(res: any, pledge: SimplePledge) {
  return res.json({
    ok: true,
    status: pledge.status,
    pledgeId: pledge.pledgeId,
    txid: pledge.txid,
    contributorAddress: pledge.contributorAddress,
    amount: pledge.amount,
    timestamp: pledge.timestamp,
    message: pledge.message,
  });
}

function sendTerminalPledgeResult(res: any, pledge: SimplePledge, txid: string) {
  if (pledge.txid === txid) {
    return sendIdempotentPledgeSuccess(res, pledge);
  }
  return res.status(409).json({ error: 'pledge-status-not-confirmable' });
}

export const confirmPledgeHandler = async (req: any, res: any) => {
  try {
    const campaignId = String(req.params.id ?? '').trim();
    const status = await getCampaignStatusById(campaignId);
    if (!status) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!hasPledgeIdentity(body)) {
      return res.status(400).json({ error: 'missing-pledge-identity' });
    }

    const txid = sanitizeTxid(body.txid);
    const pledges = await getPledgesByCampaign(campaignId);
    const pledge = selectPledgeToConfirm(pledges, body);
    if (!pledge) {
      return res.status(404).json({ error: 'pledge-not-found' });
    }

    if (isTerminalPledge(pledge)) {
      return sendTerminalPledgeResult(res, pledge, txid);
    }
    if (!isConfirmablePledge(pledge)) {
      return res.status(409).json({ error: 'pledge-status-not-confirmable' });
    }

    const verification = await pledgeVerificationService.verifyPledgeTx({
      campaignId,
      pledgeId: pledge.pledgeId,
      txid,
      expectedAmountSats: BigInt(pledge.amount),
    });

    const updated = await updatePledgeVerification({
      pledgeId: pledge.pledgeId,
      txid: verification.status === 'invalid' && verification.reason === 'txid-already-used' ? null : txid,
      status: verification.status,
      statusReason: verification.status === 'invalid' || verification.status === 'broadcasted' ? verification.reason : null,
      confirmedAt: verification.status === 'confirmed' ? new Date().toISOString() : null,
    });
    if (!updated) {
      const current = await getPledgeById(pledge.pledgeId);
      if (!current || current.campaignId !== campaignId) {
        return res.status(404).json({ error: 'pledge-not-found' });
      }
      if (isTerminalPledge(current)) {
        return sendTerminalPledgeResult(res, current, txid);
      }
      return res.status(409).json({ error: 'pledge-status-not-confirmable' });
    }

    if (verification.status === 'invalid') {
      return res.status(400).json({
        error: verification.reason,
        pledgeId: updated.pledgeId,
        txid,
        status: updated.status,
        statusReason: updated.statusReason,
      });
    }

    if (verification.status === 'broadcasted' || verification.status === 'seen_mempool') {
      return res.status(202).json({
        status: 'pending_verification',
        reason: verification.status === 'broadcasted' ? verification.reason : 'seen-mempool',
        pledgeId: updated.pledgeId,
        txid,
        pledgeStatus: updated.status,
        contributorAddress: updated.contributorAddress,
        amount: updated.amount,
        timestamp: updated.timestamp,
        message: updated.message,
        confirmations: verification.confirmations,
        actualAmountSats: verification.actualAmountSats.toString(),
        expectedAmountSats: verification.expectedAmountSats.toString(),
      });
    }

    return res.json({
      ok: true,
      pledgeId: updated.pledgeId,
      txid,
      status: updated.status,
      contributorAddress: updated.contributorAddress,
      amount: updated.amount,
      timestamp: updated.timestamp,
      message: updated.message,
      confirmations: verification.confirmations,
      actualAmountSats: verification.actualAmountSats.toString(),
      expectedAmountSats: verification.expectedAmountSats.toString(),
    });
  } catch (err) {
    const message = (err as Error).message;
    return res.status(400).json({ error: message });
  }
};

router.post('/campaign/:id/pledge', createPledgeHandler);
router.post('/campaigns/:id/pledge', createPledgeHandler);
router.post('/campaigns/:id/pledge/confirm', confirmPledgeHandler);

export default router;
