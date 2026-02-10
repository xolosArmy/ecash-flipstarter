import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { CampaignService, syncCampaignStoreFromDiskCampaigns } from '../services/CampaignService';
import { validateAddress } from '../utils/validation';
import { getUtxosForAddress, getUtxosForScript } from '../blockchain/ecashClient';
import type { Utxo } from '../blockchain/types';
import { buildPayoutTx, buildSimplePaymentTx } from '../blockchain/txBuilder';
import { serializeBuiltTx } from './serialize';
import { walletConnectOfferStore } from '../services/WalletConnectOfferStore';
import { simplePledges, type SimplePledge } from '../store/simplePledges';
import { ACTIVATION_FEE_SATS, TREASURY_ADDRESS } from '../config/constants';
import { covenantIndexInstance } from '../services/CampaignService';

type CampaignStatus = 'draft' | 'pending_fee' | 'active' | 'expired' | 'funded' | 'paid_out';

type CampaignActivation = {
  feeSats: string;
  feeTxid: string | null;
  feePaidAt: string | null;
  payerAddress: string | null;
  wcOfferId: string | null;
};

type CampaignPayout = {
  wcOfferId: string | null;
  txid: string | null;
  paidAt: string | null;
};

type Campaign = {
  id: string;
  name: string;
  description?: string;
  recipientAddress: string;
  beneficiaryAddress: string;
  address?: string;
  recipient?: string;
  goal: number;
  expiresAt: string;
  createdAt: string;
  status: CampaignStatus;
  activation: CampaignActivation;
  payout: CampaignPayout;
  location?: string | {
    latitude: number;
    longitude: number;
  };
};

const PLEDGE_FEE_SATS = 500n;
const ACTIVATION_FEE_RATE_SATS_PER_BYTE = 2n;
const TXID_HEX_REGEX = /^[0-9a-f]{64}$/i;

const router = Router();
const service = new CampaignService();
let campaigns: Campaign[] = [];
export const simpleCampaigns = new Map<string, Campaign>();
const campaignsFilePath = path.resolve(__dirname, '../../data/campaigns.json');
export function loadCampaignsFromDisk(): void {
  if (!fs.existsSync(campaignsFilePath)) {
    campaigns = [];
    simpleCampaigns.clear();
    syncCampaignStoreFromDiskCampaigns([]);
    console.log(`Campañas no cargadas: archivo no encontrado en ${campaignsFilePath}`);
    return;
  }

  try {
    const raw = fs.readFileSync(campaignsFilePath, 'utf8');
    if (!raw.trim()) {
      campaigns = [];
      simpleCampaigns.clear();
      syncCampaignStoreFromDiskCampaigns([]);
      console.log(`Cargadas 0 campañas desde ${campaignsFilePath}`);
      return;
    }
    const parsed = JSON.parse(raw) as Campaign[];
    if (!Array.isArray(parsed)) {
      console.log(`Campañas no cargadas: formato inválido en ${campaignsFilePath}`);
      return;
    }
    campaigns = parsed
      .filter((campaign) => campaign && typeof campaign.id === 'string' && campaign.id.trim())
      .map((campaign) => normalizeCampaignRecord(campaign));
    simpleCampaigns.clear();
    campaigns.forEach((campaign) => {
      simpleCampaigns.set(campaign.id, campaign);
    });
    syncCampaignStoreFromDiskCampaigns(campaigns);
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

export function getCampaignStatusById(campaignId: string): CampaignStatus | null {
  const campaign = campaigns.find((item) => item.id === campaignId);
  if (!campaign) return null;
  return deriveCampaignStatus(campaign);
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
      status: deriveCampaignStatus(campaign),
      createdAt: campaign.createdAt,
      activation: campaign.activation,
      payout: campaign.payout,
      beneficiaryAddress: campaign.beneficiaryAddress,
      description: campaign.description,
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
    return res.json({ ...campaign, status: deriveCampaignStatus(campaign) });
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
    const { name, goal, expiresAt, beneficiaryAddress, description, location } = req.body ?? {};

    if (typeof name !== 'string' || name.trim().length < 3) {
      return res.status(400).json({ error: 'Name must be at least 3 characters long.' });
    }
    if (!Number.isInteger(goal) || goal <= 0) {
      return res.status(400).json({ error: 'Goal must be a positive integer in sats.' });
    }
    if (typeof expiresAt !== 'string' || !expiresAt.trim()) {
      return res.status(400).json({ error: 'expiresAt is required.' });
    }
    if (!/^\d{4}-\d{2}-\d{2}T/.test(expiresAt.trim())) {
      return res.status(400).json({ error: 'expiresAt must be a valid ISO date string.' });
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return res.status(400).json({ error: 'expiresAt must be a valid ISO date string.' });
    }
    if (expiresAtMs <= Date.now()) {
      return res.status(400).json({ error: 'expiresAt must be in the future.' });
    }
    if (typeof beneficiaryAddress !== 'string' || !beneficiaryAddress.trim()) {
      return res.status(400).json({ error: 'beneficiaryAddress is required.' });
    }
    if (description !== undefined && typeof description !== 'string') {
      return res.status(400).json({ error: 'description must be a string.' });
    }
    if (location !== undefined && typeof location !== 'string') {
      return res.status(400).json({ error: 'location must be a string.' });
    }

    const normalizedAddress = validateAddress(beneficiaryAddress, 'beneficiaryAddress');
    const id = `campaign-${Date.now()}`;
    const campaign: Campaign = {
      id,
      name: name.trim(),
      description: typeof description === 'string' && description.trim() ? description.trim() : undefined,
      recipientAddress: normalizedAddress,
      beneficiaryAddress: normalizedAddress,
      goal,
      expiresAt: expiresAt.trim(),
      createdAt: new Date().toISOString(),
      status: 'draft',
      activation: {
        feeSats: ACTIVATION_FEE_SATS.toString(),
        feeTxid: null,
        feePaidAt: null,
        payerAddress: null,
        wcOfferId: null,
      },
      payout: {
        wcOfferId: null,
        txid: null,
        paidAt: null,
      },
      location: typeof location === 'string' && location.trim() ? location.trim() : undefined,
    };

    campaigns.push(campaign);
    simpleCampaigns.set(campaign.id, campaign);
    syncCampaignStoreFromDiskCampaigns(campaigns);
    saveCampaignsToDisk();
    return res.status(201).json(campaign);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

const createPledgeHandler: Parameters<typeof router.post>[1] = async (req, res) => {
  try {
    const campaign = campaigns.find((item) => item.id === req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (deriveCampaignStatus(campaign) !== 'active') {
      return res.status(400).json({ error: 'campaign-not-active' });
    }

    const { contributorAddress, amount } = req.body ?? {};
    const amountNum = Number(amount);
    if (
      !Number.isFinite(amountNum)
      || !Number.isInteger(amountNum)
      || amountNum < 1000
    ) {
      return res.status(400).json({
        error: 'El monto debe ser un número entero mayor o igual a 1000 satoshis.',
      });
    }

    const normalizedAddress = normalizeContributorAddress(contributorAddress);
    const beneficiaryAddress = resolveCampaignBeneficiaryAddress(campaign);
    const contributionAmount = BigInt(amountNum);
    const contributorUtxos = await selectUtxosForAmount(
      normalizedAddress,
      contributionAmount,
      PLEDGE_FEE_SATS,
    );
    const builtTx = await buildSimplePaymentTx({
      contributorUtxos,
      amount: contributionAmount,
      contributorAddress: normalizedAddress,
      beneficiaryAddress,
      fixedFee: PLEDGE_FEE_SATS,
      dustLimit: 546n,
    });
    const built = serializeBuiltTx(builtTx);

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
    const newTotalPledged = pledges.reduce((total, item) => total + item.amount, 0);
    if (deriveCampaignStatus(campaign, newTotalPledged) === 'funded') {
      campaign.status = 'funded';
      syncCampaignStoreFromDiskCampaigns(campaigns);
      saveCampaignsToDisk();
    }

    const offer = walletConnectOfferStore.createOffer({
      campaignId: campaign.id,
      unsignedTxHex: built.unsignedTxHex || built.rawHex,
      amount: String(amountNum),
      contributorAddress: normalizedAddress,
    });

    console.log(
      `[PLEDGE] campaign=${campaign.id} pledge=${pledgeId} amount=${amountNum} wcOfferId=${offer.offerId}`
    );

    const responsePayload = withBigIntsAsStrings({
      ...built,
      pledgeId,
      amount: pledge.amount,
      contributorAddress: pledge.contributorAddress,
      timestamp: pledge.timestamp,
      wcOfferId: String(offer.offerId),
    });

    return res.status(201).json(responsePayload);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

function withBigIntsAsStrings(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => withBigIntsAsStrings(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        withBigIntsAsStrings(item),
      ]),
    );
  }
  return value;
}

function normalizeContributorAddress(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('missing-address');
  }
  const trimmed = raw.trim();
  if (trimmed.includes('...')) {
    throw new Error('contributorAddress-truncated');
  }
  const prefixed = trimmed.includes(':') ? trimmed : `ecash:${trimmed}`;
  return validateAddress(prefixed, 'contributorAddress');
}

function resolveCampaignBeneficiaryAddress(campaign: Campaign): string {
  const candidate =
    campaign.beneficiaryAddress ||
    campaign.address ||
    campaign.recipient ||
    campaign.recipientAddress;
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new Error('beneficiaryAddress-required');
  }
  return validateAddress(candidate, 'beneficiaryAddress');
}

async function selectUtxosForAmount(
  contributorAddress: string,
  amount: bigint,
  fee: bigint,
): Promise<Utxo[]> {
  const utxos = await getUtxosForAddress(contributorAddress);
  const nonTokenUtxos = utxos.filter((utxo) => !hasTokenData(utxo));
  let total = 0n;
  const selected: Utxo[] = [];
  for (const utxo of nonTokenUtxos) {
    selected.push(utxo);
    total += utxo.value;
    if (total >= amount + fee) {
      break;
    }
  }
  if (total < amount + fee) {
    throw new Error('insufficient-funds-non-token');
  }
  return selected;
}

async function selectCampaignFundingUtxos(
  campaignId: string,
  amount: bigint,
  fee: bigint,
): Promise<Utxo[]> {
  const covenant = covenantIndexInstance.getCovenantRef(campaignId);
  const candidates: Utxo[] = [];

  if (covenant && covenant.scriptHash) {
    try {
      const utxos = await getUtxosForScript('p2sh', covenant.scriptHash);
      candidates.push(...utxos);
    } catch {
      // fallback to in-memory covenant ref below
    }
  }
  if (covenant && covenant.value > 0n) {
    candidates.push({
      txid: covenant.txid || '00'.repeat(32),
      vout: covenant.vout,
      value: covenant.value,
      scriptPubKey: covenant.scriptPubKey,
    });
  }

  const nonTokenUtxos = candidates.filter((utxo) => !hasTokenData(utxo));
  if (nonTokenUtxos.length === 0) {
    throw new Error('campaign-utxos-unavailable');
  }
  return pickUtxosForAmount(nonTokenUtxos, amount, fee);
}

function pickUtxosForAmount(utxos: Utxo[], amount: bigint, fee: bigint): Utxo[] {
  let total = 0n;
  const selected: Utxo[] = [];
  for (const utxo of utxos) {
    selected.push(utxo);
    total += utxo.value;
    if (total >= amount + fee) {
      break;
    }
  }
  if (total < amount + fee) {
    throw new Error('insufficient-funds');
  }
  return selected;
}

function hasTokenData(utxo: Utxo): boolean {
  return Boolean(utxo.token || utxo.slpToken || utxo.tokenStatus || utxo.plugins?.token);
}

const buildCampaignActivationHandler: Parameters<typeof router.post>[1] = async (req, res) => {
  try {
    const campaignId = req.params.id;
    const campaign = campaigns.find((item) => item.id === campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const currentStatus = deriveCampaignStatus(campaign);
    if (currentStatus !== 'draft' && currentStatus !== 'pending_fee') {
      return res.status(400).json({ error: 'campaign-not-draft' });
    }

    const payerAddress = validateAddress(req.body?.payerAddress as string, 'payerAddress');
    const feeAmount = BigInt(campaign.activation.feeSats || ACTIVATION_FEE_SATS.toString());
    const payerUtxos = await selectUtxosForAmount(payerAddress, feeAmount, PLEDGE_FEE_SATS);
    const builtTx = await buildSimplePaymentTx({
      contributorUtxos: payerUtxos,
      amount: feeAmount,
      contributorAddress: payerAddress,
      beneficiaryAddress: TREASURY_ADDRESS,
      feeRateSatsPerByte: ACTIVATION_FEE_RATE_SATS_PER_BYTE,
      dustLimit: 546n,
    });
    const built = serializeBuiltTx(builtTx);
    const offer = walletConnectOfferStore.createOffer({
      campaignId,
      unsignedTxHex: built.unsignedTxHex || built.rawHex,
      amount: feeAmount.toString(),
      contributorAddress: payerAddress,
    });

    campaign.status = 'pending_fee';
    campaign.activation.wcOfferId = offer.offerId;
    campaign.activation.payerAddress = payerAddress;
    syncCampaignStoreFromDiskCampaigns(campaigns);
    saveCampaignsToDisk();

    return res.json({
      unsignedTxHex: built.unsignedTxHex || built.rawHex,
      rawHex: built.rawHex,
      feeSats: campaign.activation.feeSats,
      payerAddress,
      campaignId,
      wcOfferId: offer.offerId,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

const confirmCampaignActivationHandler: Parameters<typeof router.post>[1] = (req, res) => {
  try {
    const campaignId = req.params.id;
    const campaign = campaigns.find((item) => item.id === campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const txid = String(req.body?.txid ?? '').trim();
    if (!TXID_HEX_REGEX.test(txid)) {
      return res.status(400).json({ error: 'txid-invalid' });
    }
    const payerAddressRaw = req.body?.payerAddress;
    const payerAddress = typeof payerAddressRaw === 'string' && payerAddressRaw.trim()
      ? validateAddress(payerAddressRaw, 'payerAddress')
      : null;

    campaign.activation.feeTxid = txid;
    campaign.activation.feePaidAt = new Date().toISOString();
    campaign.activation.payerAddress = payerAddress ?? campaign.activation.payerAddress;
    campaign.status = 'active';
    syncCampaignStoreFromDiskCampaigns(campaigns);
    saveCampaignsToDisk();

    const pledges = simplePledges.get(campaignId) ?? [];
    const totalPledged = pledges.reduce((total, pledge) => total + pledge.amount, 0);
    return res.json({
      id: campaign.id,
      name: campaign.name,
      goal: campaign.goal,
      expiresAt: campaign.expiresAt,
      createdAt: campaign.createdAt,
      beneficiaryAddress: campaign.beneficiaryAddress,
      description: campaign.description,
      location: campaign.location,
      activation: campaign.activation,
      payout: campaign.payout,
      totalPledged,
      pledgeCount: pledges.length,
      status: deriveCampaignStatus(campaign, totalPledged),
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

const buildCampaignPayoutHandler: Parameters<typeof router.post>[1] = async (req, res) => {
  try {
    const campaignId = req.params.id;
    const campaign = campaigns.find((item) => item.id === campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (deriveCampaignStatus(campaign) !== 'funded') {
      return res.status(400).json({ error: 'campaign-not-funded' });
    }

    const destinationBeneficiary = typeof req.body?.destinationBeneficiary === 'string'
      && req.body.destinationBeneficiary.trim()
      ? validateAddress(req.body.destinationBeneficiary, 'destinationBeneficiary')
      : resolveCampaignBeneficiaryAddress(campaign);
    const totalRaised = BigInt((simplePledges.get(campaignId) ?? []).reduce(
      (total, pledge) => total + pledge.amount,
      0,
    ));
    if (totalRaised <= 0n) {
      return res.status(400).json({ error: 'campaign-funds-empty' });
    }

    const campaignUtxos = await selectCampaignFundingUtxos(campaignId, totalRaised, PLEDGE_FEE_SATS);
    const builtTx = await buildPayoutTx({
      campaignUtxos,
      totalRaised,
      beneficiaryAddress: destinationBeneficiary,
      treasuryAddress: TREASURY_ADDRESS,
      fixedFee: PLEDGE_FEE_SATS,
      dustLimit: 546n,
    });
    const built = serializeBuiltTx(builtTx);
    const offer = walletConnectOfferStore.createOffer({
      campaignId,
      unsignedTxHex: built.unsignedTxHex || built.rawHex,
      amount: totalRaised.toString(),
      contributorAddress: destinationBeneficiary,
    });
    campaign.payout.wcOfferId = offer.offerId;
    syncCampaignStoreFromDiskCampaigns(campaigns);
    saveCampaignsToDisk();

    return res.json({
      unsignedTxHex: built.unsignedTxHex || built.rawHex,
      beneficiaryAmount: builtTx.beneficiaryAmount.toString(),
      treasuryCut: builtTx.treasuryCut.toString(),
      wcOfferId: offer.offerId,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

const confirmCampaignPayoutHandler: Parameters<typeof router.post>[1] = (req, res) => {
  try {
    const campaignId = req.params.id;
    const campaign = campaigns.find((item) => item.id === campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (deriveCampaignStatus(campaign) !== 'funded') {
      return res.status(400).json({ error: 'campaign-not-funded' });
    }

    const txid = String(req.body?.txid ?? '').trim();
    if (!TXID_HEX_REGEX.test(txid)) {
      return res.status(400).json({ error: 'txid-invalid' });
    }

    campaign.payout.txid = txid;
    campaign.payout.paidAt = new Date().toISOString();
    campaign.status = 'paid_out';
    syncCampaignStoreFromDiskCampaigns(campaigns);
    saveCampaignsToDisk();

    const pledges = simplePledges.get(campaignId) ?? [];
    const totalPledged = pledges.reduce((total, pledge) => total + pledge.amount, 0);
    return res.json({
      id: campaign.id,
      name: campaign.name,
      goal: campaign.goal,
      expiresAt: campaign.expiresAt,
      createdAt: campaign.createdAt,
      beneficiaryAddress: campaign.beneficiaryAddress,
      description: campaign.description,
      location: campaign.location,
      activation: campaign.activation,
      payout: campaign.payout,
      totalPledged,
      pledgeCount: pledges.length,
      status: deriveCampaignStatus(campaign, totalPledged),
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
    const pledgedRaw = pledges.reduce((total, pledge) => total + pledge.amount, 0);
    const status = deriveCampaignStatus(campaign, pledgedRaw);
    const totalPledged =
      status === 'draft' || status === 'pending_fee'
        ? 0
        : pledgedRaw;
    const pledgeCount = status === 'draft' || status === 'pending_fee' ? 0 : pledges.length;

    return res.json({
      id: campaign.id,
      name: campaign.name,
      goal: campaign.goal,
      expiresAt: campaign.expiresAt,
      createdAt: campaign.createdAt,
      beneficiaryAddress: campaign.beneficiaryAddress,
      description: campaign.description,
      location: campaign.location,
      activation: campaign.activation,
      payout: campaign.payout,
      totalPledged,
      pledgeCount,
      status,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

const confirmCampaignPledgeHandler: Parameters<typeof router.post>[1] = (req, res) => {
  try {
    const campaignId = req.params.id;
    const campaign = campaigns.find((item) => item.id === campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { pledgeId, txid } = req.body ?? {};
    if (typeof pledgeId !== 'string' || !pledgeId.trim()) {
      return res.status(400).json({ error: 'pledgeId-required' });
    }
    if (typeof txid !== 'string' || !txid.trim()) {
      return res.status(400).json({ error: 'txid-required' });
    }

    const pledges = simplePledges.get(campaignId) ?? [];
    const pledge = pledges.find((item) => item.pledgeId === pledgeId.trim());
    if (!pledge) {
      return res.status(404).json({ error: 'pledge-not-found' });
    }

    pledge.txid = txid.trim();
    simplePledges.set(campaignId, pledges);

    return res.json(
      withBigIntsAsStrings({
        ok: true,
        campaignId,
        pledgeId: pledge.pledgeId,
        txid: pledge.txid,
      }),
    );
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

const confirmLatestPendingCampaignPledgeHandler: Parameters<typeof router.post>[1] = (req, res) => {
  try {
    const campaignId = req.params.id;
    const campaign = campaigns.find((item) => item.id === campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { txid } = req.body ?? {};
    if (typeof txid !== 'string' || !txid.trim()) {
      return res.status(400).json({ error: 'txid-required' });
    }

    const pledges = simplePledges.get(campaignId) ?? [];
    let pendingPledge: SimplePledge | undefined;
    for (let index = pledges.length - 1; index >= 0; index -= 1) {
      if (pledges[index].txid === null) {
        pendingPledge = pledges[index];
        break;
      }
    }

    if (!pendingPledge) {
      return res.status(404).json({ error: 'pending-pledge-not-found' });
    }

    pendingPledge.txid = txid.trim();
    simplePledges.set(campaignId, pledges);

    return res.json(
      withBigIntsAsStrings({
        pledgeId: pendingPledge.pledgeId,
        txid: pendingPledge.txid,
        contributorAddress: pendingPledge.contributorAddress,
        amount: pendingPledge.amount,
        timestamp: pendingPledge.timestamp,
      }),
    );
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
};

function normalizeCampaignRecord(campaign: Campaign): Campaign {
  return {
    ...campaign,
    createdAt:
      typeof campaign.createdAt === 'string' && campaign.createdAt.trim()
        ? campaign.createdAt
        : new Date().toISOString(),
    status: isCampaignStatus(campaign.status) ? campaign.status : 'active',
    activation: {
      feeSats:
        typeof campaign.activation?.feeSats === 'string' && campaign.activation.feeSats.trim()
          ? campaign.activation.feeSats
          : ACTIVATION_FEE_SATS.toString(),
      feeTxid: campaign.activation?.feeTxid ?? null,
      feePaidAt: campaign.activation?.feePaidAt ?? null,
      payerAddress: campaign.activation?.payerAddress ?? null,
      wcOfferId: campaign.activation?.wcOfferId ?? null,
    },
    payout: {
      wcOfferId: campaign.payout?.wcOfferId ?? null,
      txid: campaign.payout?.txid ?? null,
      paidAt: campaign.payout?.paidAt ?? null,
    },
  };
}

function isCampaignStatus(value: unknown): value is CampaignStatus {
  return value === 'draft'
    || value === 'pending_fee'
    || value === 'active'
    || value === 'expired'
    || value === 'funded'
    || value === 'paid_out';
}

function deriveCampaignStatus(campaign: Campaign, totalPledged?: number): CampaignStatus {
  if (
    campaign.status === 'draft'
    || campaign.status === 'pending_fee'
    || campaign.status === 'paid_out'
  ) {
    return campaign.status;
  }
  const pledgedTotal =
    typeof totalPledged === 'number'
      ? totalPledged
      : (simplePledges.get(campaign.id) ?? []).reduce((total, pledge) => total + pledge.amount, 0);
  if (pledgedTotal >= campaign.goal) {
    return 'funded';
  }
  const expiresAtMs = Date.parse(campaign.expiresAt);
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
    return 'expired';
  }
  return 'active';
}

router.get('/campaign', listCampaignsHandler);
router.get('/campaigns', listCampaigns);
router.get('/campaigns/:id', getCampaignById);
router.get('/campaigns/:id/pledges', getCampaignPledgesHandler);
router.get('/campaigns/:id/summary', getCampaignSummaryHandler);
router.post('/campaigns', createCampaign);
router.post('/campaigns/:id/activate/build', buildCampaignActivationHandler);
router.post('/campaigns/:id/activate/confirm', confirmCampaignActivationHandler);
router.post('/campaigns/:id/activation/build', buildCampaignActivationHandler);
router.post('/campaigns/:id/activation/confirm', confirmCampaignActivationHandler);
router.post('/campaigns/:id/payout/build', buildCampaignPayoutHandler);
router.post('/campaigns/:id/payout/confirm', confirmCampaignPayoutHandler);
router.post('/campaigns/:id/pledge', createPledgeHandler);
router.post('/campaigns/:id/pledge/confirm', confirmLatestPendingCampaignPledgeHandler);
router.post('/campaigns/:id/pledges/confirm', confirmCampaignPledgeHandler);

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
