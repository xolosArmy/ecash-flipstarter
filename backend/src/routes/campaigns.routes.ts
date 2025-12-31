import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { CampaignService } from '../services/CampaignService';
import { validateAddress } from '../utils/validation';

type Campaign = {
  id: string;
  name: string;
  description: string;
  recipientAddress: string;
  goal: number;
  expiresAt: string;
  location?: {
    latitude: number;
    longitude: number;
  };
};

const router = Router();
const service = new CampaignService();
let campaigns: Campaign[] = [];
export const simpleCampaigns = new Map<string, Campaign>();
const campaignsFilePath = path.resolve(__dirname, '../../data/campaigns.json');
type SimplePledge = {
  pledgeId: string;
  txid: string | null;
  amount: number;
  contributorAddress: string;
  timestamp: string;
};
const simplePledges = new Map<string, SimplePledge[]>();
export function loadCampaignsFromDisk(): void {
  if (!fs.existsSync(campaignsFilePath)) {
    console.log(`Campañas no cargadas: archivo no encontrado en ${campaignsFilePath}`);
    return;
  }

  try {
    const raw = fs.readFileSync(campaignsFilePath, 'utf8');
    if (!raw.trim()) {
      console.log(`Cargadas 0 campañas desde ${campaignsFilePath}`);
      return;
    }
    const parsed = JSON.parse(raw) as Campaign[];
    if (!Array.isArray(parsed)) {
      console.log(`Campañas no cargadas: formato inválido en ${campaignsFilePath}`);
      return;
    }
    campaigns = parsed.filter(
      (campaign) => campaign && typeof campaign.id === 'string' && campaign.id.trim(),
    );
    simpleCampaigns.clear();
    campaigns.forEach((campaign) => {
      simpleCampaigns.set(campaign.id, campaign);
    });
    console.log(`Cargadas ${campaigns.length} campañas desde ${campaignsFilePath}`);
  } catch (err) {
    console.error('[campaigns] failed to load campaigns from disk', err);
  }
}

export function saveCampaignsToDisk(): void {
  const dirPath = path.dirname(campaignsFilePath);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(campaignsFilePath, JSON.stringify(campaigns, null, 2), 'utf8');
  console.log(`✅ Guardadas ${campaigns.length} campañas en ${campaignsFilePath}`);
}

const listCampaignsHandler: Parameters<typeof router.get>[1] = (_req, res) => {
  try {
    const campaigns = service.listCampaigns();
    const payload = Array.isArray(campaigns)
      ? campaigns.map((campaign) => ({
          id: campaign.id,
          name: campaign.name,
          goal: campaign.goal,
          expirationTime: campaign.expirationTime,
          beneficiaryAddress: campaign.beneficiaryAddress,
          progress: campaign.progress,
        }))
      : [];
    res.json(payload);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
};

const listCampaigns: Parameters<typeof router.get>[1] = (_req, res) => {
  try {
    const payload = campaigns.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      goal: campaign.goal,
      expiresAt: campaign.expiresAt,
      location: campaign.location,
    }));
    res.json(payload);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
};

const getCampaignById: Parameters<typeof router.get>[1] = (req, res) => {
  try {
    const campaign = campaigns.find((item) => item.id === req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    return res.json(campaign);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

router.post('/campaign', async (req, res) => {
  try {
    if (typeof req.body.beneficiaryAddress === 'string' && req.body.beneficiaryAddress.trim()) {
      req.body.beneficiaryAddress = validateAddress(req.body.beneficiaryAddress, 'beneficiaryAddress');
    }
    const campaign = await service.createCampaign(req.body);
    res.json(campaign);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

const createCampaign: Parameters<typeof router.post>[1] = (req, res) => {
  try {
    const { name, description, recipientAddress, goal, expiresAt, location } = req.body ?? {};

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name-required' });
    }
    if (typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ error: 'description-required' });
    }
    if (typeof recipientAddress !== 'string' || !recipientAddress.trim()) {
      return res.status(400).json({ error: 'recipientAddress-required' });
    }
    if (typeof goal !== 'number' || !Number.isFinite(goal) || goal <= 0) {
      return res.status(400).json({ error: 'goal-invalid' });
    }
    if (typeof expiresAt !== 'string' || !expiresAt.trim()) {
      return res.status(400).json({ error: 'expiresAt-required' });
    }
    if (Number.isNaN(Date.parse(expiresAt))) {
      return res.status(400).json({ error: 'expiresAt-invalid' });
    }
    if (location !== undefined) {
      if (typeof location !== 'object' || location === null || Array.isArray(location)) {
        return res.status(400).json({ error: 'location-invalid' });
      }
      const { latitude, longitude } = location as { latitude?: unknown; longitude?: unknown };
      if (
        typeof latitude !== 'number' ||
        !Number.isFinite(latitude) ||
        typeof longitude !== 'number' ||
        !Number.isFinite(longitude)
      ) {
        return res.status(400).json({ error: 'location-invalid' });
      }
    }

    const normalizedAddress = validateAddress(recipientAddress, 'recipientAddress');
    const id = `campaign-${Date.now()}`;
    const campaign: Campaign = {
      id,
      name: name.trim(),
      description: description.trim(),
      recipientAddress: normalizedAddress,
      goal,
      expiresAt: expiresAt.trim(),
      location: location
        ? { latitude: location.latitude, longitude: location.longitude }
        : undefined,
    };

    campaigns.push(campaign);
    simpleCampaigns.set(campaign.id, campaign);
    saveCampaignsToDisk();
    return res.status(201).json({
      id: campaign.id,
      name: campaign.name,
      goal: campaign.goal,
      expiresAt: campaign.expiresAt,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

const createPledgeHandler: Parameters<typeof router.post>[1] = (req, res) => {
  try {
    const campaign = campaigns.find((item) => item.id === req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { contributorAddress, amount } = req.body ?? {};
    const amountNum = Number(amount);
    if (typeof contributorAddress !== 'string' || !contributorAddress.trim()) {
      return res.status(400).json({ error: 'missing-address' });
    }
    if (
      !Number.isFinite(amountNum)
      || !Number.isInteger(amountNum)
      || amountNum < 1000
    ) {
      return res.status(400).json({
        error: 'El monto debe ser un número entero mayor o igual a 1000 satoshis.',
      });
    }

    const normalizedAddress = validateAddress(contributorAddress, 'contributorAddress');
    const pledgeId = `pledge-${Date.now()}`;
    const pledge: SimplePledge = {
      pledgeId,
      txid: null,
      amount: amountNum,
      contributorAddress: normalizedAddress,
      timestamp: new Date().toISOString(),
    };

    const pledges = simplePledges.get(campaign.id) ?? [];
    pledges.push(pledge);
    simplePledges.set(campaign.id, pledges);

    return res.status(201).json({
      pledgeId,
      amount: pledge.amount,
      contributorAddress: pledge.contributorAddress,
      timestamp: pledge.timestamp,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

const getCampaignPledgesHandler: Parameters<typeof router.get>[1] = (req, res) => {
  try {
    const campaignId = req.params.id;
    if (!campaigns.some((campaign) => campaign.id === campaignId)) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const pledges = simplePledges.get(campaignId) ?? [];
    const totalPledged = pledges.reduce((total, pledge) => total + pledge.amount, 0);

    return res.json({
      totalPledged,
      pledgeCount: pledges.length,
      pledges: pledges.map((pledge) => ({
        txid: pledge.txid,
        contributorAddress: pledge.contributorAddress,
        amount: pledge.amount,
        timestamp: pledge.timestamp,
      })),
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

const getCampaignSummaryHandler: Parameters<typeof router.get>[1] = (req, res) => {
  try {
    const campaignId = req.params.id;
    const campaign = campaigns.find((item) => item.id === campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const pledges = simplePledges.get(campaignId) ?? [];
    const totalPledged = pledges.reduce((total, pledge) => total + pledge.amount, 0);
    const pledgeCount = pledges.length;
    const expiresAtMs = Date.parse(campaign.expiresAt);
    const isExpired = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
    const isFunded = totalPledged >= campaign.goal;
    const status = isExpired ? 'expired' : isFunded ? 'funded' : 'active';

    return res.json({
      id: campaign.id,
      name: campaign.name,
      goal: campaign.goal,
      expiresAt: campaign.expiresAt,
      totalPledged,
      pledgeCount,
      status,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

router.get('/campaign', listCampaignsHandler);
router.get('/campaigns', listCampaigns);
router.get('/campaigns/:id', getCampaignById);
router.get('/campaigns/:id/pledges', getCampaignPledgesHandler);
router.get('/campaigns/:id/summary', getCampaignSummaryHandler);
router.post('/campaigns', createCampaign);
router.post('/campaigns/:id/pledge', createPledgeHandler);

router.get('/campaign/:id', async (req, res) => {
  try {
    const campaign = await service.getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'campaign-not-found' });
    res.json(campaign);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

export default router;
