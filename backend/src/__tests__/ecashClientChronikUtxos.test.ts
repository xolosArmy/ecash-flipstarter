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

  it('falls back from /address to /v1/address when first route is 404', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(Buffer.from('not-found'), {
          status: 404,
          headers: { 'content-type': 'application/x-protobuf' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            outputScript: '76a914abcd88ac',
            utxos: [{ outpoint: { txid: 'a'.repeat(64), outIdx: 0 }, sats: '1000' }],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        ),
      );

    vi.stubGlobal('fetch', fetchMock);
    const { getUtxosForAddress } = await import('../blockchain/ecashClient');

    const utxos = await getUtxosForAddress('ecash:qq1234');

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://chronik.xolosarmy.xyz/address/qq1234/utxos');
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://chronik.xolosarmy.xyz/v1/address/qq1234/utxos');
    expect(utxos).toEqual([
      {
        txid: 'a'.repeat(64),
        vout: 0,
        value: 1000n,
        scriptPubKey: '76a914abcd88ac',
        token: undefined,
        slpToken: undefined,
        tokenStatus: undefined,
        plugins: undefined,
      },
    ]);
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
