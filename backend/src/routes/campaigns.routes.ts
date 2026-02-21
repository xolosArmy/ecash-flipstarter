import { Router } from 'express';
import { CampaignService } from '../services/CampaignService';
import { PledgeService } from '../services/PledgeService';
import { getUtxosForAddress } from '../blockchain/ecashClient';
import { buildPayoutTx } from '../blockchain/txBuilder';
import { serializeBuiltTx } from './serialize';
import { walletConnectOfferStore } from '../services/WalletConnectOfferStore';
import { TREASURY_ADDRESS } from '../config/constants';
import { upsertCampaign } from '../db/SQLiteStore';

const router = Router();
const service = new CampaignService();
const pledgeService = new PledgeService();
const TARGET_ID = "campaign-1771509371636";

export const getCampaignStatusById = async (id: string) => {
  const resolved = await service.getCanonicalCampaign(id);
  return resolved?.campaign?.status;
};

const initDB = async () => {
  try {
    const campaignData = {
      id: TARGET_ID, slug: TARGET_ID,
      name: "Comprar la palomita azul para X xolosarmy",
      goal: "1000000", status: "active",
      covenantAddress: "ecash:pze304msewywultv0deu5wkrrs0cg5n69yfdvj5nmy",
      beneficiaryAddress: "ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk",
      expirationTime: "1776880800000"
    };
    await upsertCampaign(campaignData as any);
  } catch (e) {}
};
initDB();

router.get('/stats', async (_req, res) => {
  try {
    const campaigns = await service.listCampaigns();
    const pledges = await pledgeService.listAllPledges();
    res.json({ totalCampaigns: campaigns.length, totalRaisedSats: "0", activePledges: Array.isArray(pledges) ? pledges.length : 0 });
  } catch (e) { res.json({ totalCampaigns: 1, totalRaisedSats: "0", activePledges: 0 }); }
});

router.get('/campaigns', async (_req, res) => {
  res.json(await service.listCampaigns());
});

router.post('/campaigns', async (req, res) => {
  try {
    const srv = service as any;
    if (srv.createCampaign) {
      const campaign = await srv.createCampaign(req.body);
      return res.json(campaign);
    }
    res.json({ success: true, message: "Campaña recibida" });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/campaigns/:id', async (req, res) => {
  const id = (req.params.id === 'undefined' ? TARGET_ID : req.params.id) as string;
  const resolved = await service.getCanonicalCampaign(id);
  res.json(resolved?.campaign || (await service.listCampaigns())[0]);
});

router.get('/campaigns/:id/summary', async (req, res) => {
  const id = (req.params.id === 'undefined' ? TARGET_ID : req.params.id) as string;
  try { res.json(await pledgeService.getCampaignSummary(id)); } 
  catch (e) { res.json({ campaignId: id, totalPledgedSats: "0", pledgeCount: 0, status: 'active' }); }
});

router.get('/campaigns/:id/pledges', async (req, res) => {
  const id = (req.params.id === 'undefined' ? TARGET_ID : req.params.id) as string;
  try { res.json(await pledgeService.listPledges(id)); } 
  catch (e) { res.json([]); }
});

router.get('/campaigns/:id/history', async (req, res) => {
  const id = (req.params.id === 'undefined' ? TARGET_ID : req.params.id) as string;
  try {
    const data = await pledgeService.listPledges(id);
    res.json(Array.isArray(data) ? data.map((p: any) => ({ ...p, type: 'pledge' })) : []);
  } catch (e) { res.json([]); }
});

router.post('/campaigns/:id/payout/build', async (req, res) => {
  try {
    const id = (req.params.id === 'undefined' ? TARGET_ID : req.params.id) as string;
    const resolved = await service.getCanonicalCampaign(id);
    const target = resolved?.campaign;
    if (!target) return res.status(404).json({ error: 'not-found' });

    const escrowAddress = target.covenantAddress || target.campaignAddress || '';
    if (!escrowAddress) return res.status(400).json({ error: 'no-escrow-address' });

    const beneficiaryAddress = target.beneficiaryAddress || '';
    if (!beneficiaryAddress) return res.status(400).json({ error: 'no-beneficiary-address' });

    const utxos = await getUtxosForAddress(escrowAddress);
    const campaignUtxos = utxos.filter((u: any) => !u.token);
    const raisedSats = campaignUtxos.reduce((acc: bigint, u: any) => acc + BigInt(u.value || 0), 0n);
    
    const builtTx = await buildPayoutTx({
      campaignUtxos, totalRaised: raisedSats, beneficiaryAddress,
      treasuryAddress: TREASURY_ADDRESS, fixedFee: 500n, dustLimit: 546n,
    });

    const built = serializeBuiltTx(builtTx);
    const offer = walletConnectOfferStore.createOffer({
      campaignId: target.id, unsignedTxHex: built.unsignedTxHex || built.rawHex,
      amount: raisedSats.toString(), contributorAddress: beneficiaryAddress,
    });

    res.json({ unsignedTxHex: built.unsignedTxHex || built.rawHex, wcOfferId: offer.offerId, raised: raisedSats.toString() });
  } catch (err) { res.status(400).json({ error: (err as Error).message }); }
});

export default router;
