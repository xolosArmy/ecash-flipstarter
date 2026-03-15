import { Router } from 'express';
import { AutoPayoutService } from '../services/AutoPayoutService';

const router = Router();
const service = new AutoPayoutService();

router.post('/campaign/:id/finalize', async (req, res) => {
  try {
    const result = await service.finalizeCampaign(req.params.id);
    res.json({
      status: result.status,
      campaignId: result.campaignId,
      txid: result.txid,
      goalSats: result.goalSats.toString(),
      raisedSats: result.raisedSats.toString(),
    });
  } catch (err) {
    const message = (err as Error).message;
    const status = message === 'auto-payout-spend-path-missing' ? 409 : 400;
    res.status(status).json({ error: message });
  }
});

export default router;
