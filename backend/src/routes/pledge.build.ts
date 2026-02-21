import { Router } from 'express';
import { validateAddress } from '../utils/validation';
import { createWalletConnectPledgeOffer } from '../services/PledgeOfferService';
import { getCampaignStatusById } from './campaigns.routes';
import { CampaignService } from '../services/CampaignService';
import { parsePledgeAmountSats, parsePledgeMessage } from './pledgePayload';

const router = Router();
const campaignService = new CampaignService();

export const createPledgeBuildHandler = async (req: any, res: any) => {
  try {
    const canonicalId = await campaignService.resolveCampaignId(req.params.id);
    if (!canonicalId) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    const status = await getCampaignStatusById(canonicalId);
    if (!status) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    if (status !== 'active') {
      return res.status(400).json({ error: 'campaign-not-active' });
    }
    const ensured = await campaignService.ensureCampaignCovenant(canonicalId);
    if (!ensured.scriptHash || !ensured.scriptPubKey) {
      return res.status(400).json({ error: 'campaign-address-required' });
    }
    const campaign = await campaignService.getCampaign(canonicalId) as
      | { id?: string; campaignAddress?: string; covenantAddress?: string; escrowAddress?: string; recipientAddress?: string }
      | null;
    if (!campaign) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    const campaignAddress =
      campaign.escrowAddress ||
      campaign.covenantAddress ||
      campaign.campaignAddress;
    if (!campaignAddress) {
      return res.status(400).json({
        error: 'missing-escrow-address',
        message: 'Campaign has no persisted escrow address.'
      });
    }

    const contributorAddress = validateAddress(
      req.body.contributorAddress as string,
      'contributorAddress'
    );
    const amount = parsePledgeAmountSats(req.body);
    const message = parsePledgeMessage(req.body);
    const response = await createWalletConnectPledgeOffer(canonicalId, contributorAddress, amount, {
      campaignAddress,
      message,
    });
    const totalInputs = response.unsignedTx.inputs.reduce(
      (acc, input) => acc + BigInt(input.value),
      0n,
    );
    const change = response.unsignedTx.outputs.length > 1 ? BigInt(response.unsignedTx.outputs[1].value) : 0n;
    console.log(
      `[pledge.build] totals totalInputs=${totalInputs.toString()} amount=${amount.toString()} fee=${response.fee} change=${change.toString()}`,
    );
    return res.json({ ...response, escrowAddress: campaignAddress });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

router.post('/campaigns/:id/pledge/build', createPledgeBuildHandler);

export default router;
