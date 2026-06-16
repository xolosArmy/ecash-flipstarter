import type {
  AuditLog,
  BuiltTxResponse,
  CampaignDetail,
  CampaignSummary as ApiCampaignSummary,
  GlobalStats,
} from './types';
import type { CampaignSummary as CampaignSummaryResponse } from '../types/campaign';
import { normalizeTokenOutputs, type TokenOutputLike } from '../types/tokenOutput';

const BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ??
  (import.meta.env.PROD ? 'https://api.teyolia.cash/api' : '/api')
).replace(/\/+$/, '');

async function jsonFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${BASE_URL}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch (err) {
    console.warn('Request failed', { url, error: (err as Error).message });
    throw err;
  }
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    console.warn('Request failed', { url, status: res.status });
    const apiError = new Error(error.error || `Request failed ${res.status}`);
    (apiError as Error & { response?: { status: number; data: unknown } }).response = {
      status: res.status,
      data: error,
    };
    throw apiError;
  }
  return res.json();
}

function requireCampaignIdentifier(value: string | null | undefined, fnName: string): string {
  const campaignId = value?.trim();
  if (!campaignId) {
    throw new Error(`[api:${fnName}] campaign id is required`);
  }
  return campaignId;
}

function normalizeActivationOutputs(outputs: TokenOutputLike[] | null | undefined) {
  return normalizeTokenOutputs(outputs, { fallbackProtocol: true });
}

function normalizeCampaignRecord<T extends { activationOfferOutputs?: TokenOutputLike[] | null }>(campaign: T): T {
  return {
    ...campaign,
    activationOfferOutputs: normalizeActivationOutputs(campaign.activationOfferOutputs),
  };
}

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function fetchCampaigns(): Promise<ApiCampaignSummary[]> {
  const campaigns = await jsonFetch<ApiCampaignSummary[]>(`/campaigns`);
  return campaigns.map((campaign) => normalizeCampaignRecord(campaign));
}

export async function fetchCampaign(id: string): Promise<CampaignDetail> {
  const campaignId = requireCampaignIdentifier(id, 'fetchCampaign');
  const campaign = await jsonFetch<CampaignDetail>(`/campaigns/${campaignId}`);
  return normalizeCampaignRecord(campaign);
}

export async function fetchCampaignSummary(id: string): Promise<CampaignSummaryResponse> {
  const campaignId = requireCampaignIdentifier(id, 'fetchCampaignSummary');
  const campaign = await jsonFetch<CampaignSummaryResponse>(`/campaigns/${campaignId}/summary`);
  return normalizeCampaignRecord(campaign);
}

export interface CreateCampaignPayload {
  name: string;
  goal: number;
  expiresAt: string;
  beneficiaryAddress: string;
  beneficiaryPubKey?: string;
  contractVersion?: 'teyolia-covenant-v1' | 'legacy-placeholder';
  description?: string;
  location?: string;
}

export interface CreatedCampaign {
  id: string;
  name: string;
  goal: number;
  expiresAt: string;
  createdAt?: string;
  status?:
    | 'draft'
    | 'created'
    | 'pending_fee'
    | 'pending_verification'
    | 'fee_invalid'
    | 'expired'
    | 'funded'
    | 'active'
    | 'paid_out';
  beneficiaryAddress: string;
  description?: string;
  location?: string;
  activation?: {
    feeSats: string;
    feeTxid?: string | null;
    feePaidAt?: string | null;
    payerAddress?: string | null;
    wcOfferId?: string | null;
  };
  activationFeeRequired?: number;
  activationFeePaid?: boolean;
  activationFeeTxid?: string | null;
  activationFeePaidAt?: string | null;
  activationFeeVerificationStatus?: 'none' | 'pending_verification' | 'verified' | 'invalid';
  activationFeeVerifiedAt?: string | null;
}

export async function createCampaign(payload: CreateCampaignPayload): Promise<CreatedCampaign> {
  return jsonFetch<CreatedCampaign>(`/campaigns`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface CampaignActivationBuildResponse {
  offerId: string;
  wcOfferId: string;
  mode: 'intent' | 'tx';
  activationFeeRequired: number;
  treasuryAddress: string;
  outputs: TokenOutputLike[];
  userPrompt: string;
  feeSats: string;
  payerAddress: string;
  campaignId: string;
  // Deprecated compatibility fields for tx-build mode.
  unsignedTxHex?: string;
  rawHex?: string;
  unsignedTx?: {
    inputs: Array<{ txid: string; vout: number; value: string; scriptPubKey: string }>;
    outputs: Array<{ value: string; scriptPubKey: string }>;
    locktime?: number;
  };
  inputsUsed?: Array<{ txid: string; vout: number }>;
  outpoints?: string[];
}

export async function buildActivationTx(
  campaignId: string,
  payerAddress: string,
): Promise<CampaignActivationBuildResponse> {
  const response = await jsonFetch<CampaignActivationBuildResponse>(`/campaigns/${campaignId}/activation/build`, {
    method: 'POST',
    body: JSON.stringify({ payerAddress }),
  });
  return {
    ...response,
    outputs: normalizeActivationOutputs(response.outputs),
  };
}

export async function buildCampaignActivationTx(
  campaignId: string,
  payerAddress: string,
): Promise<CampaignActivationBuildResponse> {
  return buildActivationTx(campaignId, payerAddress);
}

export async function confirmActivationTx(
  campaignId: string,
  txid: string,
  payerAddress?: string,
): Promise<
CampaignSummaryResponse & {
  campaignId?: string;
  txid?: string | null;
  activationFeeVerificationStatus?: 'none' | 'pending_verification' | 'verified' | 'invalid';
  verificationStatus?: 'verified' | 'pending_verification' | 'invalid';
  warning?: string;
  message?: string;
}> {
  return jsonFetch<CampaignSummaryResponse & {
    campaignId?: string;
    txid?: string | null;
    activationFeeVerificationStatus?: 'none' | 'pending_verification' | 'verified' | 'invalid';
    verificationStatus?: 'verified' | 'pending_verification' | 'invalid';
    warning?: string;
    message?: string;
  }>(`/campaigns/${campaignId}/activation/confirm`, {
    method: 'POST',
    body: JSON.stringify({ txid, payerAddress }),
  });
}

export async function confirmCampaignActivationTx(
  campaignId: string,
  txid: string,
  payerAddress?: string,
): Promise<
CampaignSummaryResponse & {
  campaignId?: string;
  txid?: string | null;
  activationFeeVerificationStatus?: 'none' | 'pending_verification' | 'verified' | 'invalid';
  verificationStatus?: 'verified' | 'pending_verification' | 'invalid';
  warning?: string;
  message?: string;
}
> {
  return confirmActivationTx(campaignId, txid, payerAddress);
}

export interface CampaignActivationStatusResponse {
  status: 'draft' | 'created' | 'pending_fee' | 'pending_verification' | 'fee_invalid' | 'active' | 'expired' | 'funded' | 'paid_out';
  campaignId?: string;
  txid?: string | null;
  activationFeeRequired?: number;
  activationFeePaid?: boolean;
  activationFeeVerificationStatus?: 'none' | 'pending_verification' | 'verified' | 'invalid';
  feeTxid?: string;
  feePaidAt?: string;
  verificationStatus?: 'none' | 'pending_verification' | 'verified' | 'invalid';
  warning?: string;
}

export async function fetchCampaignActivationStatus(
  campaignId: string,
  wcOfferId?: string,
): Promise<CampaignActivationStatusResponse> {
  const query = wcOfferId ? `?wcOfferId=${encodeURIComponent(wcOfferId)}` : '';
  return jsonFetch<CampaignActivationStatusResponse>(`/campaigns/${campaignId}/activation/status${query}`);
}

export interface FinalizeCampaignResponse {
  success: boolean;
  campaignId: string;
  status: 'paid_out' | 'already_paid_out';
  txid: string | null;
  beneficiaryAddress: string;
  goalSats: string;
  raisedSats: string;
  message: string;
}

export async function finalizeCampaign(campaignId: string): Promise<FinalizeCampaignResponse> {
  return jsonFetch<FinalizeCampaignResponse>(`/campaigns/${campaignId}/finalize-request`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export interface RefundCampaignPayload {
  pledgeId: string;
}

export interface RefundCampaignResponse {
  txid: string;
  rawHex?: string;
  hex?: string;
}

export async function refundCampaign(
  campaignId: string,
  payload: RefundCampaignPayload,
): Promise<RefundCampaignResponse> {
  return jsonFetch<RefundCampaignResponse>(`/campaign/${campaignId}/refund`, {
    method: 'POST',
    body: JSON.stringify({ pledgeId: payload.pledgeId }),
  });
}

export async function createPledgeTx(
  campaignId: string,
  contributorAddress: string,
  amountXec: number,
  message?: string,
): Promise<BuiltTxResponse> {
  return jsonFetch<BuiltTxResponse>(`/campaigns/${campaignId}/pledge`, {
    method: 'POST',
    body: JSON.stringify({ contributorAddress, amountXec, message }),
  });
}

export async function createPledgeBuildTx(
  campaignId: string,
  contributorAddress: string,
  amountXec: number,
  message?: string,
): Promise<BuiltTxResponse> {
  return jsonFetch<BuiltTxResponse>(`/campaigns/${campaignId}/pledge/build`, {
    method: 'POST',
    body: JSON.stringify({ contributorAddress, amountXec, message }),
  });
}

export async function broadcastTx(
  rawTxHex: string,
): Promise<{ txid: string; backendMode?: string; message?: string }> {
  return jsonFetch<{ txid: string; backendMode?: string; message?: string }>(`/tx/broadcast`, {
    method: 'POST',
    body: JSON.stringify({ rawTxHex }),
  });
}

export async function confirmPledgeTx(
  campaignId: string,
  pledgeId: string,
  txid: string,
): Promise<{ ok: true; campaignId: string; pledgeId: string; txid: string }> {
  return jsonFetch<{ ok: true; campaignId: string; pledgeId: string; txid: string }>(
    `/campaigns/${campaignId}/pledges/confirm`,
    {
      method: 'POST',
      body: JSON.stringify({ pledgeId, txid }),
    },
  );
}

export type PledgeConfirmResponse = {
  pledgeId: string;
  txid: string;
  contributorAddress: string;
  amount: number;
  timestamp: string;
  message?: string;
  status?: string;
  pledgeStatus?: string;
  reason?: string;
};

export type PendingPledgeVerificationResponse = PledgeConfirmResponse & {
  status: 'pending_verification';
  reason: string;
};

export function isPendingPledgeVerification(
  response: PledgeConfirmResponse,
): response is PendingPledgeVerificationResponse {
  return response.status === 'pending_verification';
}

export async function confirmLatestPendingPledgeTx(
  campaignId: string,
  txid: string,
  wcOfferId?: string,
): Promise<PledgeConfirmResponse> {
  return jsonFetch<PledgeConfirmResponse>(`/campaigns/${campaignId}/pledge/confirm`, {
    method: 'POST',
    body: JSON.stringify({ txid, wcOfferId }),
  });
}

export async function confirmLatestPendingPledgeTxWithRetry(
  campaignId: string,
  txid: string,
  wcOfferId?: string,
  options: { retryDelayMs?: number; timeoutMs?: number } = {},
): Promise<PledgeConfirmResponse> {
  const retryDelayMs = options.retryDelayMs ?? 3_000;
  const timeoutMs = options.timeoutMs ?? 90_000;
  let response = await confirmLatestPendingPledgeTx(campaignId, txid, wcOfferId);

  for (let elapsed = 0; isPendingPledgeVerification(response) && elapsed < timeoutMs; elapsed += retryDelayMs) {
    await wait(retryDelayMs);
    response = await confirmLatestPendingPledgeTx(campaignId, txid, wcOfferId);
    if (retryDelayMs <= 0) break;
  }

  return response;
}

export interface CampaignPledgesResponse {
  totalPledged: number;
  pendingTotalPledged: number;
  pledgeCount: number;
  pledges: Array<{
    txid: string | null;
    contributorAddress: string;
    amount: number;
    timestamp: string;
    message?: string;
    status?: 'intent' | 'broadcasted' | 'seen_mempool' | 'confirmed' | 'finalized' | 'expired' | 'refunded' | 'invalid';
    statusReason?: string | null;
  }>;
}

type CampaignPledgesApiPayload =
  | CampaignPledgesResponse
  | CampaignPledgesResponse['pledges'];

const CONFIRMED_PLEDGE_STATUSES = new Set(['confirmed', 'finalized']);
const PENDING_PLEDGE_STATUSES = new Set(['intent', 'broadcasted', 'seen_mempool']);

function normalizeCampaignPledgesPayload(payload: CampaignPledgesApiPayload): CampaignPledgesResponse {
  if (Array.isArray(payload)) {
    const pledges = payload.map((pledge) => ({
      txid: pledge.txid ?? null,
      contributorAddress: pledge.contributorAddress,
      amount: Number(pledge.amount) || 0,
      timestamp: pledge.timestamp,
      message: pledge.message,
      status: pledge.status,
      statusReason: pledge.statusReason ?? null,
    }));
    const totalPledged = pledges
      .filter((pledge) => CONFIRMED_PLEDGE_STATUSES.has(String(pledge.status ?? 'intent')))
      .reduce((sum, pledge) => sum + pledge.amount, 0);
    const pendingTotalPledged = pledges
      .filter((pledge) => PENDING_PLEDGE_STATUSES.has(String(pledge.status ?? 'intent')))
      .reduce((sum, pledge) => sum + pledge.amount, 0);
    return {
      totalPledged,
      pendingTotalPledged,
      pledgeCount: pledges.length,
      pledges,
    };
  }

  if (Array.isArray(payload.pledges)) {
    const pledges = payload.pledges.map((pledge) => ({
      txid: pledge.txid ?? null,
      contributorAddress: pledge.contributorAddress,
      amount: Number(pledge.amount) || 0,
      timestamp: pledge.timestamp,
      message: pledge.message,
      status: pledge.status,
      statusReason: pledge.statusReason ?? null,
    }));
    return {
      totalPledged: Number(payload.totalPledged) || pledges.filter((pledge) => CONFIRMED_PLEDGE_STATUSES.has(String(pledge.status ?? 'intent'))).reduce((sum, pledge) => sum + pledge.amount, 0),
      pendingTotalPledged: Number((payload as CampaignPledgesResponse).pendingTotalPledged) || pledges.filter((pledge) => PENDING_PLEDGE_STATUSES.has(String(pledge.status ?? 'intent'))).reduce((sum, pledge) => sum + pledge.amount, 0),
      pledgeCount: Number(payload.pledgeCount) || pledges.length,
      pledges,
    };
  }

  return { totalPledged: 0, pendingTotalPledged: 0, pledgeCount: 0, pledges: [] };
}

export async function fetchCampaignPledges(campaignId: string): Promise<CampaignPledgesResponse> {
  const requiredCampaignId = campaignId?.trim();
  if (!requiredCampaignId) {
    return { totalPledged: 0, pendingTotalPledged: 0, pledgeCount: 0, pledges: [] };
  }

  const url = `${BASE_URL}/campaigns/${requiredCampaignId}/pledges`;

  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      return { totalPledged: 0, pendingTotalPledged: 0, pledgeCount: 0, pledges: [] };
    }

    const payload = (await res.json()) as CampaignPledgesApiPayload;
    return normalizeCampaignPledgesPayload(payload);
  } catch (_err) {
    return { totalPledged: 0, pendingTotalPledged: 0, pledgeCount: 0, pledges: [] };
  }
}

export async function fetchGlobalStats(): Promise<GlobalStats> {
  return jsonFetch<GlobalStats>(`/stats`);
}

export async function fetchCampaignHistory(id: string): Promise<AuditLog[]> {
  const campaignId = requireCampaignIdentifier(id, 'fetchCampaignHistory');
  return jsonFetch<AuditLog[]>(`/campaigns/${campaignId}/history`);
}
