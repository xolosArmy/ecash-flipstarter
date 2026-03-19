import { Router } from 'express';
import { RefundService } from '../services/RefundService';
import { serializeBuiltTx } from './serialize';
import { validateAddress } from '../utils/validation';

const router = Router();
const service = new RefundService();

router.post('/campaign/:id/refund', async (req, res) => {
  try {
    const refundAddress = validateAddress(req.body.refundAddress as string, 'refundAddress');
    const refundAmount = BigInt(req.body.refundAmount);
    const result = await service.refundCampaign(req.params.id, refundAddress, refundAmount);
    res.json({
      txid: result.txid,
      ...serializeBuiltTx(result.builtTx),
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

export default router;
