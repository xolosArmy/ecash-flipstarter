import { Router } from 'express';
import { validateAddress } from '../utils/validation';
import { createWalletConnectPledgeOffer } from '../services/PledgeOfferService';
import { getCampaignStatusById } from './campaigns.routes';
import { CampaignService } from '../services/CampaignService';
import { parsePledgeAmountSats, parsePledgeMessage } from './pledgePayload';
import {
  assertLegacyPlaceholderMonetaryOperationsAllowed,
  isLegacyPlaceholderDisabledError,
  legacyPlaceholderDisabledBody,
  LEGACY_PLACEHOLDER_DISABLED_STATUS,
} from '../security/legacyPlaceholderFreeze';

const router = Router();
const campaignService = new CampaignService();

export const createPledgeBuildHandler = async (req: any, res: any) => {
  try {
    const campaign = await campaignService.getCampaign(req.params.id) as
      | { campaignAddress?: string; covenantAddress?: string; contractVersion?: string | null }
      | null;
    if (!campaign) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    assertLegacyPlaceholderMonetaryOperationsAllowed(campaign);

    const status = await getCampaignStatusById(req.params.id);
    if (!status) {
      return res.status(404).json({ error: 'campaign-not-found' });
    }
    if (status !== 'active') {
      return res.status(400).json({ error: 'campaign-not-active' });
    }
    const ensured = await campaignService.ensureCampaignCovenant(req.params.id);
    if (!ensured.scriptHash || !ensured.scriptPubKey) {
      return res.status(400).json({ error: 'campaign-address-required' });
    }
    const campaignAddress = campaign?.campaignAddress || campaign?.covenantAddress || '';
    if (!campaignAddress) {
      return res.status(400).json({ error: 'campaign-address-required' });
    }

    const contributorAddress = validateAddress(
      req.body.contributorAddress as string,
      'contributorAddress'
    );
    const amount = parsePledgeAmountSats(req.body);
    const message = parsePledgeMessage(req.body);
    const response = await createWalletConnectPledgeOffer(req.params.id, contributorAddress, amount, {
      campaignAddress,
      message,
    });
    const totalInputs = response.unsignedTx.inputs.reduce(
      (acc, input) => acc + BigInt(input.value),
      0n,
    );
    const change = response.unsignedTx.outputs.length > 1 ? BigInt(response.unsignedTx.outputs[1].value) : 0n;
    console.log(
      `[pledge.build] totals totalInputs=${totalInputs.toString()} amount=${amount.toString()} fee=${response.fee} change=${change.toString()}`,
    );
    return res.json(response);
  } catch (err) {
    if (isLegacyPlaceholderDisabledError(err)) {
      return res
        .status(LEGACY_PLACEHOLDER_DISABLED_STATUS)
        .json(legacyPlaceholderDisabledBody());
    }
    return res.status(400).json({ error: (err as Error).message });
  }
};

router.post('/campaigns/:id/pledge/build', createPledgeBuildHandler);

export default router;
