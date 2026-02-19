import { Router } from 'express';
import { RefundService } from '../services/RefundService';
import { serializeBuiltTx } from './serialize';
import { validateAddress } from '../utils/validation';
import { CampaignService } from '../services/CampaignService';

const router = Router();
const service = new RefundService();
const campaignService = new CampaignService();

router.post('/campaign/:id/refund', async (req, res) => {
  try {
    const canonicalId = await campaignService.resolveCampaignId(req.params.id);
    if (!canonicalId) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    const refundAddress = validateAddress(req.body.refundAddress as string, 'refundAddress');
    const refundAmount = BigInt(req.body.refundAmount);
    const tx = await service.createRefundTx(canonicalId, refundAddress, refundAmount);
    return res.json(serializeBuiltTx(tx));
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

export default router;
