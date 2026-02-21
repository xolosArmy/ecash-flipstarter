import { Router } from 'express';
import { CampaignService } from '../services/CampaignService';
import { PledgeService } from '../services/PledgeService';
import { getUtxosForAddress } from '../blockchain/ecashClient';
import { buildPayoutTx } from '../blockchain/txBuilder';
import { serializeBuiltTx } from './serialize';
import { walletConnectOfferStore } from '../services/WalletConnectOfferStore';
import { TREASURY_ADDRESS } from '../config/constants';
import { upsertCampaign, openDatabase } from '../db/SQLiteStore';

const router = Router();
const service = new CampaignService();
const pledgeService = new PledgeService();

// Función auxiliar para obtener estado
export const getCampaignStatusById = async (id: string) => {
  const resolved = await service.getCanonicalCampaign(id);
  return resolved?.campaign?.status;
};

// Sincronización inicial (Solo asegura que existan, no sobreescribe todo)
const initDB = async () => {
  try {
    const db = await openDatabase();
    // Intentamos cargar campañas existentes desde el archivo JSON si la DB está vacía
    await service.listCampaigns(); 
    console.log("[DB] Sistema de campañas listo.");
  } catch (e) {
    console.error("[DB] Error en inicialización:", e);
  }
};
initDB();

router.get('/stats', async (_req, res) => {
  try {
    const campaigns = await service.listCampaigns();
    const pledges = await pledgeService.listAllPledges();
    res.json({ 
      totalCampaigns: campaigns.length, 
      totalRaisedSats: "0", 
      activePledges: Array.isArray(pledges) ? pledges.length : 0 
    });
  } catch (e) { 
    res.json({ totalCampaigns: 0, totalRaisedSats: "0", activePledges: 0 }); 
  }
});

// Obtener TODAS las campañas
router.get('/campaigns', async (_req, res) => {
  try {
    const camps = await service.listCampaigns();
    res.json(camps);
  } catch(e) {
    res.status(500).json({ error: "Error al listar campañas" });
  }
});

router.post('/campaigns', async (req, res) => {
  try {
    const srv = service as any;
    const campaign = await srv.createCampaign(req.body);
    res.json(campaign);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/campaigns/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const resolved = await service.getCanonicalCampaign(id);
    if (!resolved) return res.status(404).json({ error: "Campaña no encontrada" });
    res.json(resolved.campaign);
  } catch (e) {
    res.status(404).json({ error: "Error al buscar campaña" });
  }
});

router.get('/campaigns/:id/summary', async (req, res) => {
  try {
    res.json(await pledgeService.getCampaignSummary(req.params.id));
  } catch (e) {
    res.json({ campaignId: req.params.id, totalPledgedSats: "0", pledgeCount: 0, status: 'unknown' });
  }
});

router.get('/campaigns/:id/history', async (req, res) => {
  try {
    const data = await pledgeService.listPledges(req.params.id);
    res.json(Array.isArray(data) ? data.map((p: any) => ({ ...p, type: 'pledge' })) : []);
  } catch (e) { res.json([]); }
});

router.post('/campaigns/:id/payout/build', async (req, res) => {
  try {
    const id = req.params.id;
    const resolved = await service.getCanonicalCampaign(id);
    const target = resolved?.campaign;
    if (!target) return res.status(404).json({ error: 'not-found' });

    const escrowAddress = target.covenantAddress || target.campaignAddress || '';
    const beneficiaryAddress = target.beneficiaryAddress || '';

    const utxos = await getUtxosForAddress(escrowAddress);
    const campaignUtxos = utxos.filter((u: any) => !u.token);
    const raisedSats = campaignUtxos.reduce((acc: bigint, u: any) => acc + BigInt(u.value || 0), 0n);
    
    const builtTx = await buildPayoutTx({
      campaignUtxos, 
      totalRaised: raisedSats, 
      beneficiaryAddress,
      treasuryAddress: TREASURY_ADDRESS, 
      fixedFee: 500n, 
      dustLimit: 546n,
    });

    const built = serializeBuiltTx(builtTx);
    const offer = walletConnectOfferStore.createOffer({
      campaignId: target.id, 
      unsignedTxHex: built.unsignedTxHex || built.rawHex,
      amount: raisedSats.toString(), 
      contributorAddress: beneficiaryAddress,
    });

    res.json({ 
      unsignedTxHex: built.unsignedTxHex || built.rawHex, 
      wcOfferId: offer.offerId, 
      raised: raisedSats.toString() 
    });
  } catch (err) { res.status(400).json({ error: (err as Error).message }); }
});

export default router;
