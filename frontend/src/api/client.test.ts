import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmActivationTx } from './client';

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
