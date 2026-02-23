import type {
  AuditLog,
  BuiltTxResponse,
  CampaignDetail,
  CampaignSummary as ApiCampaignSummary,
  GlobalStats,
} from './types';
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
    const text = await res.text().catch(() => '');
    const data = (() => {
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    })();
    console.error('HTTP request failed', {
      url,
      status: res.status,
      message: typeof data === 'object' && data && 'error' in data ? String((data as { error?: unknown }).error ?? '') : `Request failed ${res.status}`,
      data,
      text,
      headers: Object.fromEntries(res.headers.entries()),
    });
    const apiError = new Error(
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error?: unknown }).error ?? `Request failed ${res.status}`)
        : `Request failed ${res.status}`,
    );
    (apiError as Error & { response?: { status: number; data: unknown; text: string } }).response = {
      status: res.status,
      data,
      text,
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
  // Guard against malformed identifiers so callers do not trigger /campaigns/undefined/... requests.
  const raw = (id ?? '').toString().trim();
  if (!raw || raw === 'undefined' || raw === 'null') {
    throw new Error(`Invalid campaign id for summary: "${raw}"`);
  }
  const safe = encodeURIComponent(raw);
  return jsonFetch<CampaignSummaryResponse>(`/campaigns/${safe}/summary`);
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
  slug?: string;
  publicId?: string;
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
  outputs: Array<{ address: string; valueSats: number }>;
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

export interface CampaignPayoutBuildResponse {
  unsignedTxHex: string;
  beneficiaryAmount: string;
  treasuryCut: string;
  wcOfferId: string;
  escrowAddress?: string;
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

export async function confirmLatestPendingPledgeTx(
  campaignId: string,
  txid: string,
  wcOfferId?: string,
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
    body: JSON.stringify({ txid, wcOfferId }),
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

export async function fetchGlobalStats(): Promise<GlobalStats> {
  return jsonFetch<GlobalStats>(`/stats`);
}

export async function fetchCampaignHistory(id: string): Promise<AuditLog[]> {
  return jsonFetch<AuditLog[]>(`/campaigns/${id}/history`);
}
