import { Router } from 'express';
import { CampaignService } from '../services/CampaignService';
import { PledgeService } from '../services/PledgeService';
import { getUtxosForAddress } from '../blockchain/ecashClient';
import { buildPayoutTx } from '../blockchain/txBuilder';
import { serializeBuiltTx } from './serialize';
import { walletConnectOfferStore } from '../services/WalletConnectOfferStore';
import { TREASURY_ADDRESS } from '../config/constants';

const router = Router();
const service = new CampaignService();
const pledgeService = new PledgeService();

export const getCampaignStatusById = async (id: string) => {
  const resolved = await service.getCanonicalCampaign(id);
  return resolved?.campaign?.status;
};

router.get('/stats', async (_req, res) => {
  try {
    const campaigns = await service.listCampaigns();
    const pledges = await pledgeService.listAllPledges();
    res.json({ 
      totalCampaigns: campaigns.length, 
      totalRaisedSats: pledges.reduce((acc: number, p: any) => acc + (p.amount || 0), 0).toString(), 
      activePledges: pledges.length 
    });
  } catch (e) { res.json({ totalCampaigns: 0, totalRaisedSats: "0", activePledges: 0 }); }
});

router.get('/campaigns', async (_req, res) => {
  res.json(await service.listCampaigns());
});

router.get('/campaigns/:id/summary', async (req, res) => {
  res.json(await pledgeService.getCampaignSummary(req.params.id));
});

router.get('/campaigns/:id/history', async (req, res) => {
  try {
    const data = await pledgeService.listPledges(req.params.id);
    res.json(data.map((p: any) => ({
      id: p.pledgeId,
      type: 'pledge',
      timestamp: p.timestamp,
      payload: {
        contributorAddress: p.contributorAddress,
        amount: p.amount,
        txid: p.txid,
        message: p.message
      }
    })));
  } catch (e) { res.json([]); }
});

router.get('/campaigns/:id', async (req, res) => {
  const resolved = await service.getCanonicalCampaign(req.params.id);
  res.json(resolved?.campaign || (await service.listCampaigns())[0]);
});

router.post('/campaigns/:id/payout/build', async (req, res) => {
  try {
    const resolved = await service.getCanonicalCampaign(req.params.id);
    const target = resolved?.campaign;
    if (!target) return res.status(404).json({ error: 'not-found' });
    const escrowAddress = target.covenantAddress || target.campaignAddress || '';
    const utxos = await getUtxosForAddress(escrowAddress);
    const campaignUtxos = utxos.filter((u: any) => !u.token);
    const raisedSats = campaignUtxos.reduce((acc: bigint, u: any) => acc + BigInt(u.value || 0), 0n);
    const builtTx = await buildPayoutTx({
      campaignUtxos, totalRaised: raisedSats, beneficiaryAddress: target.beneficiaryAddress || '',
      treasuryAddress: TREASURY_ADDRESS, fixedFee: 500n, dustLimit: 546n,
    });
    const built = serializeBuiltTx(builtTx);
    const offer = walletConnectOfferStore.createOffer({
      campaignId: target.id, unsignedTxHex: built.unsignedTxHex || built.rawHex,
      amount: raisedSats.toString(), contributorAddress: target.beneficiaryAddress || '',
    });
    res.json({ unsignedTxHex: built.unsignedTxHex || built.rawHex, wcOfferId: offer.offerId, raised: raisedSats.toString() });
  } catch (err) { res.status(400).json({ error: (err as Error).message }); }
});

export default router;
