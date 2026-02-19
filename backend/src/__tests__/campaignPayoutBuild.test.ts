import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCanonicalCampaignMock = vi.fn();
const listCampaignsMock = vi.fn().mockResolvedValue([]);
const setPayoutOfferMock = vi.fn().mockResolvedValue(undefined);
const getUtxosForAddressMock = vi.fn();
const buildPayoutTxMock = vi.fn();
const createOfferMock = vi.fn().mockReturnValue({ offerId: 'offer-123' });
const sqliteUpsertCampaignMock = vi.fn().mockResolvedValue(undefined);
const saveCampaignsToDiskMock = vi.fn().mockResolvedValue(undefined);
const syncCampaignStoreFromDiskCampaignsMock = vi.fn();

vi.mock('../blockchain/ecashClient', async () => {
  const actual = await vi.importActual<typeof import('../blockchain/ecashClient')>('../blockchain/ecashClient');
  return {
    ...actual,
    getUtxosForAddress: getUtxosForAddressMock,
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

const BASE_CAMPAIGN = {
  id: 'camp-canonical',
  slug: 'camp-slug',
  name: 'Campaign',
  goal: '1000',
  expirationTime: String(Date.now() + 86_400_000),
  beneficiaryAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
  campaignAddress: 'ecash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqu08dsy2',
  status: 'active',
};

describe('buildCampaignPayoutHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCanonicalCampaignMock.mockResolvedValue({ canonicalId: 'camp-canonical', campaign: BASE_CAMPAIGN });
    listCampaignsMock.mockResolvedValue([BASE_CAMPAIGN]);
  });

  it('returns 400 insufficient-funds-on-chain with structured details', async () => {
    const { buildCampaignPayoutHandler } = (await import('../routes/campaigns.routes')) as {
      buildCampaignPayoutHandler: (req: any, res: any) => Promise<void>;
    };

    getUtxosForAddressMock.mockResolvedValue([
      { txid: 'a'.repeat(64), vout: 0, value: 600n, scriptPubKey: '76a914', token: { tokenId: '1' } },
      { txid: 'b'.repeat(64), vout: 1, value: 300n, scriptPubKey: '76a914' },
      { txid: 'c'.repeat(64), vout: 2, value: 100n, scriptPubKey: '76a914', tokenStatus: 'TOKEN_STATUS_NORMAL' },
    ]);

    const req = { params: { id: 'camp-slug' }, body: {} };
    const res = createMockRes();

    await buildCampaignPayoutHandler(req as any, res as any);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'insufficient-funds-on-chain',
      details: {
        escrowAddress: BASE_CAMPAIGN.campaignAddress,
        goal: '1000',
        raised: '300',
        missing: '700',
        utxoCount: 1,
      },
    });
    expect(buildPayoutTxMock).not.toHaveBeenCalled();
  });

  it('uses canonical campaignId for offer and persistence flow', async () => {
    const { buildCampaignPayoutHandler } = (await import('../routes/campaigns.routes')) as {
      buildCampaignPayoutHandler: (req: any, res: any) => Promise<void>;
    };

    getUtxosForAddressMock.mockResolvedValue([
      { txid: 'd'.repeat(64), vout: 0, value: 1500n, scriptPubKey: '76a914', slpToken: undefined },
    ]);
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
