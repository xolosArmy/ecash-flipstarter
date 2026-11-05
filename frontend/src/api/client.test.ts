import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmActivationTx,
  confirmLatestPendingPledgeTx,
  confirmLatestPendingPledgeTxWithRetry,
  fetchCampaignPledges,
} from './client';

describe('confirmActivationTx', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts txid to activation confirm endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'camp-1', status: 'active', activationFeePaid: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await confirmActivationTx('camp-1', 'a'.repeat(64), 'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/campaigns/camp-1/activation/confirm',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          txid: 'a'.repeat(64),
          payerAddress: 'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
        }),
      }),
    );
  });
});

describe('confirmLatestPendingPledgeTx', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns pending_verification without throwing for 202 responses', async () => {
    const txid = 'b'.repeat(64);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        status: 'pending_verification',
        reason: 'txid-not-found',
        pledgeId: 'pledge-1',
        txid,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(confirmLatestPendingPledgeTx('camp-1', txid, 'offer-1')).resolves.toMatchObject({
      status: 'pending_verification',
      reason: 'txid-not-found',
      txid,
    });
  });

  it('polls pending_verification and returns a later confirmed response', async () => {
    const txid = 'c'.repeat(64);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({
          status: 'pending_verification',
          reason: 'txid-not-found',
          pledgeId: 'pledge-1',
          txid,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'confirmed',
          pledgeId: 'pledge-1',
          txid,
          contributorAddress: 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59jrf5035',
          amount: 1000,
          timestamp: '2026-06-16T00:00:00.000Z',
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      confirmLatestPendingPledgeTxWithRetry('camp-1', txid, 'offer-1', { retryDelayMs: 0, timeoutMs: 1 }),
    ).resolves.toMatchObject({ status: 'confirmed', txid });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchCampaignPledges', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves pledgeId and wcOfferId from the backend response', async () => {
    const txid = 'd'.repeat(64);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        totalPledged: 500000,
        pendingTotalPledged: 0,
        pledgeCount: 1,
        pledges: [
          {
            pledgeId: 'pledge-123456789',
            wcOfferId: 'wc-offer-abc123',
            txid,
            contributorAddress: 'ecash:qr0ft6aq66hnj4xcfecqvskvh5ssu8cgjs53pqwyca',
            amount: 500000,
            timestamp: '2026-08-12T19:00:00.000Z',
            status: 'confirmed',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCampaignPledges('campaign-test');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/campaigns/campaign-test/pledges',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
    expect(result.pledges[0]).toMatchObject({
      pledgeId: 'pledge-123456789',
      wcOfferId: 'wc-offer-abc123',
      txid,
      amount: 500000,
      status: 'confirmed',
    });
  });
});
