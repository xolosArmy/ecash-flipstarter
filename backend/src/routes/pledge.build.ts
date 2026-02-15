import { Router } from 'express';
import { validateAddress } from '../utils/validation';
import { createWalletConnectPledgeOffer } from '../services/PledgeOfferService';
import { getCampaignStatusById } from './campaigns.routes';
import { CampaignService } from '../services/CampaignService';

const router = Router();
const campaignService = new CampaignService();

router.post('/campaigns/:id/pledge/build', async (req, res) => {
  try {
    const status = await getCampaignStatusById(req.params.id);
    if (!status) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    if (status !== 'active') {
      return res.status(400).json({ error: 'campaign-not-active' });
    }
    const ensured = await campaignService.ensureCampaignCovenant(req.params.id);
    if (!ensured.scriptHash || !ensured.scriptPubKey) {
      return res.status(400).json({ error: 'campaign-address-required' });
    }

    const contributorAddress = validateAddress(
      req.body.contributorAddress as string,
      'contributorAddress'
    );
    const amount = BigInt(req.body.amount);
    if (amount <= 0n) {
      return res.status(400).json({ error: 'amount-required' });
    }
    const response = await createWalletConnectPledgeOffer(req.params.id, contributorAddress, amount);
    const totalInputs = response.unsignedTx.inputs.reduce(
      (acc, input) => acc + BigInt(input.value),
      0n,
    );
    const change = response.unsignedTx.outputs.length > 1 ? BigInt(response.unsignedTx.outputs[1].value) : 0n;
    console.log(
      `[pledge.build] totals totalInputs=${totalInputs.toString()} amount=${amount.toString()} fee=${response.fee} change=${change.toString()}`,
    );
    return res.json(response);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

export default router;
