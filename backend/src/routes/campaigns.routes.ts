import { Router } from 'express';
import { CampaignService } from '../services/CampaignService';
import { validateAddress } from '../utils/validation';


const router = Router();
const service = new CampaignService();

router.post('/campaign', async (req, res) => {
  try {
    if (typeof req.body.beneficiaryAddress === 'string' && req.body.beneficiaryAddress.trim()) {
      req.body.beneficiaryAddress = validateAddress(req.body.beneficiaryAddress, 'beneficiaryAddress');
    }
    const campaign = await service.createCampaign(req.body);
    res.json(campaign);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/campaign', async (_req, res) => {
  try {
    const campaigns = service.listCampaigns();
    const payload = Array.isArray(campaigns)
      ? campaigns.map((campaign) => ({
          id: campaign.id,
          name: campaign.name,
          goal: campaign.goal,
          expirationTime: campaign.expirationTime,
          beneficiaryAddress: campaign.beneficiaryAddress,
          progress: campaign.progress,
        }))
      : [];
    res.json(payload);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/campaign/:id', async (req, res) => {
  try {
    const campaign = await service.getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'campaign-not-found' });
    res.json(campaign);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

export default router;
