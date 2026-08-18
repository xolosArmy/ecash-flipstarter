import { Router } from 'express';
import { FinalizeService } from '../services/FinalizeService';
import {
  isLegacyPlaceholderDisabledError,
  legacyPlaceholderDisabledBody,
  LEGACY_PLACEHOLDER_DISABLED_STATUS,
} from '../security/legacyPlaceholderFreeze';

const router = Router();
const service = new FinalizeService();

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
    if (isLegacyPlaceholderDisabledError(err)) {
      return res
        .status(LEGACY_PLACEHOLDER_DISABLED_STATUS)
        .json(legacyPlaceholderDisabledBody());
    }
    const message = (err as Error).message;
    const status = (
      message === 'auto-payout-spend-path-missing'
      || message === 'auto-payout-unsupported-for-v1'
    ) ? 409 : 400;
    res.status(status).json({ error: message });
  }
});

export default router;
