import { Router } from 'express';
import { walletConnectOfferStore } from '../services/WalletConnectOfferStore';
import { CampaignService } from '../services/CampaignService';
import {
  assertLegacyPlaceholderMonetaryOperationsAllowed,
  isLegacyPlaceholderDisabledError,
  legacyPlaceholderDisabledBody,
  LEGACY_PLACEHOLDER_DISABLED_STATUS,
} from '../security/legacyPlaceholderFreeze';

const router = Router();
const campaignService = new CampaignService();

router.get('/walletconnect/offers/:offerId', async (req, res) => {
  const offerId = req.params.offerId;
  const offer = walletConnectOfferStore.get(offerId);
  if (!offer) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[walletconnect] offer not found or expired: ${offerId}`);
    }
    return res.status(404).json({ error: 'offer-not-found' });
  }
  try {
    const campaign = await campaignService.getCampaign(offer.campaignId) as
      | { contractVersion?: string | null }
      | null;
    assertLegacyPlaceholderMonetaryOperationsAllowed(campaign);
  } catch (err) {
    if (isLegacyPlaceholderDisabledError(err)) {
      return res
        .status(LEGACY_PLACEHOLDER_DISABLED_STATUS)
        .json(legacyPlaceholderDisabledBody());
    }
    return res.status(400).json({ error: (err as Error).message });
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
