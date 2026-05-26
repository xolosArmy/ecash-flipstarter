import { Router } from 'express';
import { RefundService } from '../services/RefundService';
import { serializeBuiltTx } from './serialize';

const router = Router();
const service = new RefundService();

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function publicRefundsEnabled(): boolean {
  return parseBooleanEnv(process.env.ENABLE_PUBLIC_REFUNDS, false);
}

router.post('/campaign/:id/refund', async (req, res) => {
  if (!publicRefundsEnabled()) {
    return res.status(403).json({
      error: 'public-refunds-disabled',
      message: 'Public refunds are disabled. Refunds must be claimed from verified pledge ownership and campaign expiry state.',
    });
  }

  try {
    if (req.body?.refundAddress !== undefined) {
      return res.status(400).json({
        error: 'refund-address-from-request-disabled',
        message: 'Refund address is derived from the original verified contributor address, not the request body.',
      });
    }
    if (req.body?.refundAmount !== undefined) {
      return res.status(400).json({
        error: 'refund-amount-from-request-disabled',
        message: 'Refund amount is derived from the verified pledge record, not the request body.',
      });
    }

    const pledgeId = String(req.body?.pledgeId ?? '').trim();
    if (!pledgeId) {
      return res.status(400).json({ error: 'pledge-id-required' });
    }

    const result = await service.refundCampaign({
      campaignId: req.params.id,
      pledgeId,
    });
    res.json({
      txid: result.txid,
      pledgeId: result.pledgeId,
      contributorAddress: result.contributorAddress,
      refundAmountSats: result.refundAmountSats,
      ...serializeBuiltTx(result.builtTx),
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

export default router;
