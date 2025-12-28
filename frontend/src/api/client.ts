import type {
  BuiltTxResponse,
  CampaignDetail,
  CampaignSummary,
} from './types';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api').replace(
  /\/+$/,
  ''
);

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
    throw new Error(error.error || `Request failed ${res.status}`);
  }
  return res.json();
}

export async function fetchCampaigns(): Promise<CampaignSummary[]> {
  return jsonFetch<CampaignSummary[]>(`/campaign`);
}

export async function fetchCampaign(id: string): Promise<CampaignDetail> {
  return jsonFetch<CampaignDetail>(`/campaign/${id}`);
}

export async function createPledgeTx(
  campaignId: string,
  contributorAddress: string,
  amount: bigint,
): Promise<BuiltTxResponse> {
  return jsonFetch<BuiltTxResponse>(`/campaign/${campaignId}/pledge`, {
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
