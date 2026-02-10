import { Router } from 'express';
import { validateAddress } from '../utils/validation';
import { createWalletConnectPledgeOffer } from '../services/PledgeOfferService';
import { getCampaignStatusById } from './campaigns.routes';

const router = Router();

const createPledgeHandler: Parameters<typeof router.post>[1] = async (req, res) => {
  try {
    const status = getCampaignStatusById(req.params.id);
    if (!status) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    if (status !== 'active') {
      return res.status(400).json({ error: 'campaign-not-active' });
    }

    const amount = BigInt(req.body.amount);
    const contributorAddress = validateAddress(
      req.body.contributorAddress as string,
      'contributorAddress'
    );
    const response = await createWalletConnectPledgeOffer(req.params.id, contributorAddress, amount);
    res.json(response);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
};

router.post('/campaign/:id/pledge', createPledgeHandler);
router.post('/campaigns/:id/pledge', createPledgeHandler);

export default router;
