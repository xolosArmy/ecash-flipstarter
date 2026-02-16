import { Router } from 'express';
import { validateAddress } from '../utils/validation';
import { createWalletConnectPledgeOffer } from '../services/PledgeOfferService';
import { getCampaignStatusById } from './campaigns.routes';
import { CampaignService } from '../services/CampaignService';
import { parsePledgeAmountSats, parsePledgeMessage } from './pledgePayload';
import { getPledgesByCampaign, updatePledgeTxid, type SimplePledge } from '../store/simplePledges';

const router = Router();
const campaignService = new CampaignService();
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

    const amount = parsePledgeAmountSats(req.body);
    const message = parsePledgeMessage(req.body);
    const contributorAddress = validateAddress(
      req.body.contributorAddress as string,
      'contributorAddress'
    );
    const response = await createWalletConnectPledgeOffer(req.params.id, contributorAddress, amount, {
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

  for (let idx = pledges.length - 1; idx >= 0; idx -= 1) {
    if (pledges[idx].txid === null) {
      return pledges[idx];
    }
  }
  return undefined;
}

export const confirmPledgeHandler = async (req: any, res: any) => {
  try {
    const campaignId = String(req.params.id ?? '').trim();
    const status = await getCampaignStatusById(campaignId);
    if (!status) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }

    const txid = sanitizeTxid(req.body?.txid);
    const pledges = await getPledgesByCampaign(campaignId);
    const pledge = selectPledgeToConfirm(pledges, (req.body ?? {}) as Record<string, unknown>);
    if (!pledge) {
      return res.status(404).json({ error: 'pledge-not-found' });
    }

    if (pledge.txid) {
      return res.json({
        ok: true,
        status: 'already_confirmed',
        pledgeId: pledge.pledgeId,
        txid: pledge.txid,
        contributorAddress: pledge.contributorAddress,
        amount: pledge.amount,
        timestamp: pledge.timestamp,
        message: pledge.message,
      });
    }

    const updated = await updatePledgeTxid(pledge.pledgeId, txid);
    if (!updated) {
      return res.status(404).json({ error: 'pledge-not-found' });
    }

    return res.json({
      ok: true,
      pledgeId: pledge.pledgeId,
      txid,
      contributorAddress: pledge.contributorAddress,
      amount: pledge.amount,
      timestamp: pledge.timestamp,
      message: pledge.message,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

router.post('/campaign/:id/pledge', createPledgeHandler);
router.post('/campaigns/:id/pledge', createPledgeHandler);
router.post('/campaigns/:id/pledge/confirm', confirmPledgeHandler);

export default router;
