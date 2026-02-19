import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCanonicalCampaignMock = vi.fn();
const listCampaignsMock = vi.fn().mockResolvedValue([]);
const setPayoutOfferMock = vi.fn().mockResolvedValue(undefined);
const fetchChronikUtxosMock = vi.fn();
const buildPayoutTxMock = vi.fn();
const createOfferMock = vi.fn().mockReturnValue({ offerId: 'offer-123' });
const sqliteUpsertCampaignMock = vi.fn().mockResolvedValue(undefined);
const saveCampaignsToDiskMock = vi.fn().mockResolvedValue(undefined);
const syncCampaignStoreFromDiskCampaignsMock = vi.fn();

vi.mock('../blockchain/ecashClient', async () => {
  const actual = await vi.importActual<typeof import('../blockchain/ecashClient')>('../blockchain/ecashClient');
  return {
    ...actual,
    fetchChronikUtxos: fetchChronikUtxosMock,
    addressToScriptPubKey: vi.fn(),
    getTransactionInfo: vi.fn(),
  };
});

vi.mock('../blockchain/txBuilder', () => ({
  buildPayoutTx: buildPayoutTxMock,
}));

vi.mock('../services/WalletConnectOfferStore', () => ({
  walletConnectOfferStore: {
    createOffer: createOfferMock,
  },
}));

vi.mock('../db/SQLiteStore', () => ({
  upsertCampaign: sqliteUpsertCampaignMock,
}));

vi.mock('../store/campaignPersistence', () => ({
  saveCampaignsToDisk: saveCampaignsToDiskMock,
}));

vi.mock('../services/CampaignService', () => {
  return {
    CampaignService: class {
      getCanonicalCampaign = getCanonicalCampaignMock;
      listCampaigns = listCampaignsMock;
      setPayoutOffer = setPayoutOfferMock;
    },
    syncCampaignStoreFromDiskCampaigns: syncCampaignStoreFromDiskCampaignsMock,
  };
});

function createBaseCampaign(status: 'active' | 'funded' | 'paid_out' = 'active') {
  return {
    id: 'camp-canonical',
    slug: 'camp-slug',
    name: 'Campaign',
    goal: '1000',
    expirationTime: String(Date.now() + 86_400_000),
    beneficiaryAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
    campaignAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
    covenantAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
    escrowAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
    status,
  };
}

describe('buildCampaignPayoutHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createOfferMock.mockReturnValue({ offerId: 'offer-123' });
    const campaign = createBaseCampaign();
    getCanonicalCampaignMock.mockResolvedValue({ canonicalId: 'camp-canonical', campaign });
    listCampaignsMock.mockResolvedValue([campaign]);
  });

  it('returns 400 insufficient-funds with structured details', async () => {
    const { buildCampaignPayoutHandler } = (await import('../routes/campaigns.routes')) as {
      buildCampaignPayoutHandler: (req: any, res: any) => Promise<void>;
    };

    const campaign = createBaseCampaign();
    getCanonicalCampaignMock.mockResolvedValue({ canonicalId: 'camp-canonical', campaign });

    fetchChronikUtxosMock.mockResolvedValue({
      usedUrl: 'https://chronik.xolosarmy.xyz/address/qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk/utxos',
      status: 200,
      contentType: 'application/json',
      branch: 'json',
      utxos: [
        { txid: 'a'.repeat(64), vout: 0, value: 600n, scriptPubKey: '76a914', token: { tokenId: '1' } },
        { txid: 'b'.repeat(64), vout: 1, value: 300n, scriptPubKey: '76a914' },
        { txid: 'c'.repeat(64), vout: 2, value: 100n, scriptPubKey: '76a914', tokenStatus: 'TOKEN_STATUS_NORMAL' },
      ],
    });

    const req = { params: { id: 'camp-slug' }, body: {} };
    const res = createMockRes();

    await buildCampaignPayoutHandler(req as any, res as any);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'insufficient-funds',
      details: {
        campaignId: 'camp-canonical',
        escrowAddress: campaign.campaignAddress,
        chronikUrl: 'https://chronik.xolosarmy.xyz',
        usedUrl: 'https://chronik.xolosarmy.xyz/address/qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk/utxos',
        status: 200,
        contentType: 'application/json',
        utxoCount: 3,
        raisedSats: '300',
        goal: '1000',
        branch: 'json',
        derivedScriptHash: null,
      },
    });
    expect(buildPayoutTxMock).not.toHaveBeenCalled();
  });

  it('returns 503 chronik-unavailable when chronik lookup fails', async () => {
    const { buildCampaignPayoutHandler } = (await import('../routes/campaigns.routes')) as {
      buildCampaignPayoutHandler: (req: any, res: any) => Promise<void>;
    };
    const { ChronikUnavailableError } = await import('../blockchain/ecashClient');

    fetchChronikUtxosMock.mockRejectedValue(
      new ChronikUnavailableError('chronik-protobuf-mode', {
        url: 'https://chronik.xolosarmy.xyz/address/qq/utxos',
        status: 200,
        contentType: 'application/x-protobuf',
        bodyPreviewHex: '0a0b0c',
      }),
    );

    const req = { params: { id: 'camp-slug' }, body: {} };
    const res = createMockRes();

    await buildCampaignPayoutHandler(req as any, res as any);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: 'chronik-unavailable',
      details: {
        campaignId: 'camp-canonical',
        escrowAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
        chronikUrl: 'https://chronik.xolosarmy.xyz',
        triedUrl: 'https://chronik.xolosarmy.xyz/address/qq/utxos',
        status: 200,
        contentType: 'application/x-protobuf',
        bodyPreviewHex: '0a0b0c',
        branch: 'protobuf',
      },
    });
    expect(buildPayoutTxMock).not.toHaveBeenCalled();
  });

  it('rejects build when payout was already processed', async () => {
    const { buildCampaignPayoutHandler } = (await import('../routes/campaigns.routes')) as {
      buildCampaignPayoutHandler: (req: any, res: any) => Promise<void>;
    };

    getCanonicalCampaignMock.mockResolvedValue({
      canonicalId: 'camp-canonical',
      campaign: createBaseCampaign('funded'),
    });

    const req = { params: { id: 'camp-slug' }, body: {} };
    const res = createMockRes();

    await buildCampaignPayoutHandler(req as any, res as any);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'payout-already-processed' });
    expect(fetchChronikUtxosMock).not.toHaveBeenCalled();
    expect(buildPayoutTxMock).not.toHaveBeenCalled();
  });

  it('uses canonical campaignId for offer and persistence flow', async () => {
    const { buildCampaignPayoutHandler } = (await import('../routes/campaigns.routes')) as {
      buildCampaignPayoutHandler: (req: any, res: any) => Promise<void>;
    };

    fetchChronikUtxosMock.mockResolvedValue({
      usedUrl: 'https://chronik.xolosarmy.xyz/address/qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk/utxos',
      status: 200,
      contentType: 'application/json',
      branch: 'json',
      utxos: [
        { txid: 'd'.repeat(64), vout: 0, value: 1500n, scriptPubKey: '76a914', slpToken: undefined },
      ],
    });
    buildPayoutTxMock.mockResolvedValue({
      beneficiaryAmount: 1200n,
      treasuryCut: 300n,
      unsignedTx: { inputs: [], outputs: [] },
      rawHex: 'abcd',
      unsignedTxHex: 'abcd',
    });

    const req = { params: { id: 'camp-slug' }, body: {} };
    const res = createMockRes();

    await buildCampaignPayoutHandler(req as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(createOfferMock).toHaveBeenCalledWith(expect.objectContaining({ campaignId: 'camp-canonical', amount: '1500' }));
    expect(setPayoutOfferMock).toHaveBeenCalledWith('camp-canonical', 'offer-123');
    expect(sqliteUpsertCampaignMock).toHaveBeenCalled();
    expect(saveCampaignsToDiskMock).toHaveBeenCalled();
  });
});

function createMockRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}
