import type { BuiltTxResponse, CampaignDetail, CampaignSummary as ApiCampaignSummary } from './types';
import type { CampaignSummary as CampaignSummaryResponse } from '../types/campaign';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '');

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

export async function fetchCampaigns(): Promise<ApiCampaignSummary[]> {
  return jsonFetch<ApiCampaignSummary[]>(`/campaigns`);
}

export async function fetchCampaign(id: string): Promise<CampaignDetail> {
  return jsonFetch<CampaignDetail>(`/campaigns/${id}`);
}

export async function fetchCampaignSummary(id: string): Promise<CampaignSummaryResponse> {
  return jsonFetch<CampaignSummaryResponse>(`/campaigns/${id}/summary`);
}

export interface CreateCampaignPayload {
  name: string;
  goal: number;
  expiresAt: string;
  beneficiaryAddress: string;
  description?: string;
  location?: string;
}

export interface CreatedCampaign {
  id: string;
  name: string;
  goal: number;
  expiresAt: string;
  createdAt?: string;
  status?: 'draft' | 'pending_fee' | 'expired' | 'funded' | 'active' | 'paid_out';
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
}

export async function createCampaign(payload: CreateCampaignPayload): Promise<CreatedCampaign> {
  return jsonFetch<CreatedCampaign>(`/campaigns`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface CampaignActivationBuildResponse {
  unsignedTxHex: string;
  rawHex?: string;
  feeSats: string;
  payerAddress: string;
  campaignId: string;
  wcOfferId: string;
}

export async function buildActivationTx(
  campaignId: string,
  payerAddress: string,
): Promise<CampaignActivationBuildResponse> {
  return jsonFetch<CampaignActivationBuildResponse>(`/campaigns/${campaignId}/activation/build`, {
    method: 'POST',
    body: JSON.stringify({ payerAddress }),
  });
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
): Promise<CampaignSummaryResponse> {
  return jsonFetch<CampaignSummaryResponse>(`/campaigns/${campaignId}/activation/confirm`, {
    method: 'POST',
    body: JSON.stringify({ txid, payerAddress }),
  });
}

export async function confirmCampaignActivationTx(
  campaignId: string,
  txid: string,
  payerAddress?: string,
): Promise<CampaignSummaryResponse> {
  return confirmActivationTx(campaignId, txid, payerAddress);
}

export interface CampaignActivationStatusResponse {
  status: 'draft' | 'pending_fee' | 'active' | 'expired' | 'funded' | 'paid_out';
  feeTxid?: string;
  feePaidAt?: string;
}

export async function fetchCampaignActivationStatus(
  campaignId: string,
  wcOfferId?: string,
): Promise<CampaignActivationStatusResponse> {
  const query = wcOfferId ? `?wcOfferId=${encodeURIComponent(wcOfferId)}` : '';
  return jsonFetch<CampaignActivationStatusResponse>(`/campaigns/${campaignId}/activation/status${query}`);
}

export interface CampaignPayoutBuildResponse {
  unsignedTxHex: string;
  beneficiaryAmount: string;
  treasuryCut: string;
  wcOfferId: string;
}

export async function buildPayoutTx(campaignId: string): Promise<CampaignPayoutBuildResponse> {
  return jsonFetch<CampaignPayoutBuildResponse>(`/campaigns/${campaignId}/payout/build`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function confirmPayoutTx(
  campaignId: string,
  txid: string,
): Promise<CampaignSummaryResponse> {
  return jsonFetch<CampaignSummaryResponse>(`/campaigns/${campaignId}/payout/confirm`, {
    method: 'POST',
    body: JSON.stringify({ txid }),
  });
}

export async function createPledgeTx(
  campaignId: string,
  contributorAddress: string,
  amount: bigint,
  message?: string,
): Promise<BuiltTxResponse> {
  return jsonFetch<BuiltTxResponse>(`/campaigns/${campaignId}/pledge`, {
    method: 'POST',
    body: JSON.stringify({ contributorAddress, amount: amount.toString(), message }),
  });
}

export async function createPledgeBuildTx(
  campaignId: string,
  contributorAddress: string,
  amount: bigint,
): Promise<BuiltTxResponse> {
  return jsonFetch<BuiltTxResponse>(`/campaigns/${campaignId}/pledge/build`, {
    method: 'POST',
    body: JSON.stringify({ contributorAddress, amount: amount.toString() }),
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

export async function confirmLatestPendingPledgeTx(
  campaignId: string,
  txid: string,
): Promise<{
  pledgeId: string;
  txid: string;
  contributorAddress: string;
  amount: number;
  timestamp: string;
  message?: string;
}> {
  return jsonFetch<{
    pledgeId: string;
    txid: string;
    contributorAddress: string;
    amount: number;
    timestamp: string;
    message?: string;
  }>(`/campaigns/${campaignId}/pledge/confirm`, {
    method: 'POST',
    body: JSON.stringify({ txid }),
  });
}

export interface CampaignPledgesResponse {
  totalPledged: number;
  pledgeCount: number;
  pledges: Array<{
    txid: string | null;
    contributorAddress: string;
    amount: number;
    timestamp: string;
    message?: string;
  }>;
}

export async function fetchCampaignPledges(campaignId: string): Promise<CampaignPledgesResponse> {
  return jsonFetch<CampaignPledgesResponse>(`/campaigns/${campaignId}/pledges`);
}
