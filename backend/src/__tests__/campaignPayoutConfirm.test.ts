import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCanonicalCampaignMock = vi.fn();
const markPayoutCompleteMock = vi.fn().mockResolvedValue(undefined);
const getCampaignMock = vi.fn();
const sqliteUpsertCampaignMock = vi.fn().mockResolvedValue(undefined);
const getPledgesByCampaignMock = vi.fn();

vi.mock('../services/CampaignService', () => ({
  CampaignService: class {
    getCanonicalCampaign = getCanonicalCampaignMock;
    markPayoutComplete = markPayoutCompleteMock;
    getCampaign = getCampaignMock;
  },
  syncCampaignStoreFromDiskCampaigns: vi.fn(),
}));

vi.mock('../db/SQLiteStore', () => ({
  upsertCampaign: sqliteUpsertCampaignMock,
}));

vi.mock('../store/simplePledges', () => ({
  getPledgesByCampaign: getPledgesByCampaignMock,
}));

vi.mock('../blockchain/ecashClient', async () => {
  const actual = await vi.importActual<typeof import('../blockchain/ecashClient')>('../blockchain/ecashClient');
  return {
    ...actual,
    getUtxosForAddress: vi.fn(),
    addressToScriptPubKey: vi.fn(),
    getTransactionInfo: vi.fn(),
  };
});

function createCampaign(status: 'active' | 'funded' | 'paid_out') {
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
    payout: {
      txid: null,
      paidAt: null,
      wcOfferId: 'offer-123',
    },
  };
}

describe('confirmCampaignPayoutHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPledgesByCampaignMock.mockResolvedValue([
      { amount: 400, txid: 'a'.repeat(64), contributorAddress: 'ecash:qp1', timestamp: 1 },
      { amount: 700, txid: 'b'.repeat(64), contributorAddress: 'ecash:qp2', timestamp: 2 },
    ]);
  });

  it('rejects confirm when campaign status is not funded', async () => {
    const { confirmCampaignPayoutHandler } = (await import('../routes/campaigns.routes')) as {
      confirmCampaignPayoutHandler: (req: any, res: any) => Promise<void>;
    };

    getCanonicalCampaignMock.mockResolvedValue({
      canonicalId: 'camp-canonical',
      campaign: createCampaign('active'),
    });

    const req = { params: { id: 'camp-slug' }, body: { txid: 'a'.repeat(64) } };
    const res = createMockRes();

    await confirmCampaignPayoutHandler(req as any, res as any);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'payout-not-allowed' });
    expect(markPayoutCompleteMock).not.toHaveBeenCalled();
    expect(sqliteUpsertCampaignMock).not.toHaveBeenCalled();
  });

  it('confirms payout and persists paid_out status with payout txid', async () => {
    const { confirmCampaignPayoutHandler } = (await import('../routes/campaigns.routes')) as {
      confirmCampaignPayoutHandler: (req: any, res: any) => Promise<void>;
    };

    const funded = createCampaign('funded');
    const confirmedTxid = 'c'.repeat(64);
    const updated = {
      ...funded,
      status: 'paid_out',
      payout: {
        txid: confirmedTxid,
        paidAt: '2026-01-01T00:00:00.000Z',
        wcOfferId: 'offer-123',
      },
    };

    getCanonicalCampaignMock.mockResolvedValue({ canonicalId: 'camp-canonical', campaign: funded });
    getCampaignMock.mockResolvedValue(updated);

    const req = { params: { id: 'camp-slug' }, body: { txid: confirmedTxid } };
    const res = createMockRes();

    await confirmCampaignPayoutHandler(req as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(markPayoutCompleteMock).toHaveBeenCalledWith('camp-canonical', confirmedTxid, expect.any(String));
    expect(sqliteUpsertCampaignMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'camp-canonical',
      status: 'paid_out',
      payout: expect.objectContaining({ txid: confirmedTxid }),
    }));
    expect(res.body).toEqual(expect.objectContaining({
      status: 'paid_out',
      payout: expect.objectContaining({ txid: confirmedTxid }),
      pledgeCount: 2,
    }));
  });

  it('rejects a second confirm after payout is already completed', async () => {
    const { confirmCampaignPayoutHandler } = (await import('../routes/campaigns.routes')) as {
      confirmCampaignPayoutHandler: (req: any, res: any) => Promise<void>;
    };

    getCanonicalCampaignMock.mockResolvedValue({
      canonicalId: 'camp-canonical',
      campaign: createCampaign('paid_out'),
    });

    const req = { params: { id: 'camp-slug' }, body: { txid: 'd'.repeat(64) } };
    const res = createMockRes();

    await confirmCampaignPayoutHandler(req as any, res as any);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'payout-not-allowed' });
    expect(markPayoutCompleteMock).not.toHaveBeenCalled();
    expect(sqliteUpsertCampaignMock).not.toHaveBeenCalled();
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
