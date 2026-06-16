import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmActivationTx, confirmLatestPendingPledgeTx, confirmLatestPendingPledgeTxWithRetry } from './client';

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
