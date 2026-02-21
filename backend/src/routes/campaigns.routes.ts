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

// Estadísticas globales de todas las campañas
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

// Lista TODAS las campañas con sus detalles
router.get('/campaigns', async (_req, res) => {
  try {
    let camps = await service.listCampaigns();
    // Si la lista está vacía, intentamos hidratar la DB una vez
    if (camps.length === 0) {
       await (require('../services/CampaignService').hydrateCampaignStore)();
       camps = await service.listCampaigns();
    }
    res.json(camps);
  } catch (e) { res.json([]); }
});

// Detalle de una campaña específica por ID o Slug
router.get('/campaigns/:id', async (req, res) => {
  try {
    const resolved = await service.getCanonicalCampaign(req.params.id);
    if (!resolved) return res.status(404).json({ error: 'not-found' });
    res.json(resolved.campaign);
  } catch (e) { res.status(404).json({ error: 'error-fetching' }); }
});

router.get('/campaigns/:id/summary', async (req, res) => {
  res.json(await pledgeService.getCampaignSummary(req.params.id));
});

// Historial formateado para el Frontend (AuditLog)
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

export const buildCampaignPayoutHandler = async (req: any, res: any) => {
  try {
    const resolved = await service.getCanonicalCampaign(req.params.id);
    const campaign = resolved?.campaign;
    if (!campaign) return res.status(404).json({ error: 'not-found' });

    const escrowAddress =
      campaign.escrowAddress ||
      campaign.covenantAddress ||
      campaign.campaignAddress;

    if (!escrowAddress) {
      return res.status(400).json({
        error: 'missing-escrow-address',
        message: 'Campaign has no persisted escrow address.'
      });
    }

    console.log('[PAYOUT]', {
      campaignId: campaign.id,
      escrowAddressUsed: escrowAddress
    });

    const utxos = await getUtxosForAddress(escrowAddress);
    const campaignUtxos = utxos.filter((u: any) => !u.token);
    const raisedSats = campaignUtxos.reduce((acc: bigint, u: any) => acc + BigInt(u.value || 0), 0n);
    const builtTx = await buildPayoutTx({
      campaignUtxos,
      totalRaised: raisedSats,
      beneficiaryAddress: campaign.beneficiaryAddress || '',
      treasuryAddress: TREASURY_ADDRESS,
      fixedFee: 500n,
      dustLimit: 546n,
    });
    const built = serializeBuiltTx(builtTx);
    const offer = walletConnectOfferStore.createOffer({
      campaignId: campaign.id,
      unsignedTxHex: built.unsignedTxHex || built.rawHex,
      amount: raisedSats.toString(),
      contributorAddress: campaign.beneficiaryAddress || '',
    });
    return res.json({
      unsignedTxHex: built.unsignedTxHex || built.rawHex,
      wcOfferId: offer.offerId,
      raised: raisedSats.toString(),
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

router.post('/campaigns/:id/payout/build', buildCampaignPayoutHandler);

export default router;
