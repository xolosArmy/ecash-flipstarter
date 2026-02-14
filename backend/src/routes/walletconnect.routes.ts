import { Router } from 'express';
import { walletConnectOfferStore } from '../services/WalletConnectOfferStore';

const router = Router();

router.get('/walletconnect/offers/:offerId', (req, res) => {
  const offerId = req.params.offerId;
  const offer = walletConnectOfferStore.get(offerId);
  if (!offer) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[walletconnect] offer not found or expired: ${offerId}`);
    }
    return res.status(404).json({ error: 'offer-not-found' });
  }
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[walletconnect] offer resolved: ${offerId}`);
  }
  return res.json({
    offerId: offer.offerId,
    unsignedTxHex: offer.unsignedTxHex,
    mode: offer.mode ?? (offer.unsignedTxHex ? 'tx' : 'intent'),
    outputs: offer.outputs ?? [],
    userPrompt: offer.userPrompt,
    campaignId: offer.campaignId,
    amount: offer.amount,
    contributorAddress: offer.contributorAddress,
    expiresAt: offer.expiresAt,
  });
});

export default router;
