import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('chronik-client', () => ({
  ChronikClient: class {
    script() {
      return { utxos: async () => ({ utxos: [], outputScript: '' }) };
    }
    broadcastTx = async () => ({ txid: 'mock-txid' });
    tx = async () => ({ outputs: [] });
    blockchainInfo = async () => ({ tipHeight: 0 });
  },
}));

describe('getUtxosForAddress chronik raw endpoint handling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.env.E_CASH_BACKEND = 'chronik';
    process.env.CHRONIK_URL = 'https://chronik.xolosarmy.xyz';
  });

  it('throws ChronikUnavailableError when /address route returns 404', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(Buffer.from('not-found'), {
          status: 404,
          headers: { 'content-type': 'application/x-protobuf' },
        }),
      );

    vi.stubGlobal('fetch', fetchMock);
    const { getUtxosForAddress } = await import('../blockchain/ecashClient');

    await expect(getUtxosForAddress('ecash:qq1234')).rejects.toMatchObject({
      name: 'ChronikUnavailableError',
      message: 'chronik-http-error',
      details: {
        url: 'https://chronik.xolosarmy.xyz/address/qq1234/utxos',
        status: 404,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://chronik.xolosarmy.xyz/address/qq1234/utxos');
  });

  it('throws ChronikUnavailableError when chronik responds protobuf', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(Buffer.from([0, 1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'application/x-protobuf' },
        }),
      ),
    );

    const { ChronikUnavailableError, getUtxosForAddress } = await import('../blockchain/ecashClient');

    await expect(getUtxosForAddress('ecash:qq1234')).rejects.toMatchObject({
      name: 'ChronikUnavailableError',
      message: 'chronik-protobuf-mode',
      details: {
        url: 'https://chronik.xolosarmy.xyz/address/qq1234/utxos',
        status: 200,
        contentType: 'application/x-protobuf',
        bodyPreviewHex: '00010203',
        hint: 'chronik-protobuf-mode; backend expected json',
      },
    });

    expect(ChronikUnavailableError).toBeTypeOf('function');
  });
});
