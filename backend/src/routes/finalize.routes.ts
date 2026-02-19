import { Router } from 'express';
import { FinalizeService } from '../services/FinalizeService';
import { serializeBuiltTx } from './serialize';
import { validateAddress } from '../utils/validation';
import { CampaignService } from '../services/CampaignService';

const router = Router();
const service = new FinalizeService();
const campaignService = new CampaignService();

router.post('/campaign/:id/finalize', async (req, res) => {
  try {
    const canonicalId = await campaignService.resolveCampaignId(req.params.id);
    if (!canonicalId) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    const beneficiaryAddress = validateAddress(
      req.body.beneficiaryAddress as string,
      'beneficiaryAddress'
    );
    const tx = await service.createFinalizeTx(canonicalId, beneficiaryAddress);
    return res.json(serializeBuiltTx(tx));
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

export default router;
