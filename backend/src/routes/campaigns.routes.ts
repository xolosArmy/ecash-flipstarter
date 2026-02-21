import { Router } from 'express';
import { CampaignService } from '../services/CampaignService';
import { PledgeService } from '../services/PledgeService';

const router = Router();
const service = new CampaignService();
const pledgeService = new PledgeService();

// Lista TODAS las campañas guardadas en SQLite
router.get('/campaigns', async (_req, res) => {
  try {
    const camps = await service.listCampaigns();
    res.json(camps);
  } catch (e) {
    res.status(500).json({ error: "Error al obtener campañas" });
  }
});

// Historial de donaciones (Pledges) para una campaña específica
router.get('/campaigns/:id/history', async (req, res) => {
  try {
    const pledges = await pledgeService.listPledges(req.params.id);
    res.json(pledges.map(p => ({
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

// Resumen de recaudación
router.get('/campaigns/:id/summary', async (req, res) => {
  try {
    const summary = await pledgeService.getCampaignSummary(req.params.id);
    res.json(summary);
  } catch (e) { res.status(404).json({ error: "No se encontró resumen" }); }
});

export default router;
