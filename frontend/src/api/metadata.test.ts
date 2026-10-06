import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCampaign, fetchCampaign, fetchCampaigns, fetchCampaignSummary, fetchCapabilities } from './client';

const metadata = {
  apiVersion: 'teyolia.metadata.v1', recordKind: 'metadata-only', monetaryEnabled: false,
  capabilities: { monetary: false }, id: 'metadata-1', name: 'Propuesta', description: 'Solo planificación',
  goal: '123456789012345678901234567890', expirationTime: '4102444800000',
  expiresAt: '2100-01-01T00:00:00.000Z', createdAt: '2026-10-04T00:00:00.000Z', status: 'draft',
  planning: { thesis: 'Hipótesis', proposedPnL: { estimated: '10', guaranteed: false } },
  location: { latitude: 19.43, longitude: -99.13 },
};
afterEach(() => { vi.unstubAllGlobals(); });
describe('metadata API consumers', () => {
  it('preserves the explicit response, string precision and absent instrument fields on all reads', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true, json: async () => url.endsWith('/campaigns') ? [metadata] : metadata,
    }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchCampaigns()).toEqual([metadata]);
    expect(await fetchCampaign('metadata-1')).toEqual(metadata);
    expect(await fetchCampaignSummary('metadata-1')).toEqual(metadata);
    expect(await fetchCapabilities()).toEqual(metadata);
    expect(Object.keys(await fetchCampaign('metadata-1'))).toEqual(Object.keys(metadata));
  });
  it('posts metadata without address, pubkey, contract, activation or wallet fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => metadata });
    vi.stubGlobal('fetch', fetchMock);
    const payload = { name: metadata.name, description: metadata.description, goal: metadata.goal, expiresAt: metadata.expiresAt, planning: metadata.planning, location: metadata.location };
    expect(await createCampaign(payload)).toEqual(metadata);
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0][1];
    expect(JSON.parse(request.body)).toEqual(payload);
    expect(request.method).toBe('POST');
  });
});
