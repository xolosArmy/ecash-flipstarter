import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCampaignByIdMock = vi.fn();
const getUtxosForAddressMock = vi.fn();

vi.mock('express', () => ({
  Router: () => ({
    get: vi.fn(),
    post: vi.fn(),
  }),
}));

vi.mock('../db/SQLiteStore', () => ({
  getCampaignById: getCampaignByIdMock,
}));

vi.mock('../blockchain/ecashClient', () => ({
  ChronikUnavailableError: class ChronikUnavailableError extends Error {},
  addressToScriptPubKey: vi.fn(),
  getEffectiveChronikBaseUrl: vi.fn(),
  getTransactionInfo: vi.fn(),
  getUtxosForAddress: getUtxosForAddressMock,
  isSpendableXecUtxo: vi.fn(() => true),
}));

vi.mock('../services/CampaignService', () => ({
  CampaignService: vi.fn().mockImplementation(() => ({
    getCanonicalCampaign: vi.fn(),
    listCampaigns: vi.fn(),
    getCampaign: vi.fn(),
    setActivationOffer: vi.fn(),
    recordActivationFeeBroadcast: vi.fn(),
    finalizeActivationFeeVerification: vi.fn(),
    setPayoutOffer: vi.fn(),
    markPayoutComplete: vi.fn(),
  })),
}));

vi.mock('../services/PledgeService', () => ({
  PledgeService: vi.fn().mockImplementation(() => ({
    listAllPledges: vi.fn(),
    getCampaignSummary: vi.fn(),
    listPledges: vi.fn(),
  })),
}));

describe('debugEscrowHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when campaign is not found', async () => {
    const { debugEscrowHandler } = await import('../routes/campaigns.routes');

    getCampaignByIdMock.mockResolvedValue(null);

    const req = { params: { id: 'missing-campaign' } } as any;
    const res = createMockRes();

    await debugEscrowHandler(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'campaign-not-found' });
  });

  it('returns diagnostics and handles address-utxos-not-found as empty list', async () => {
    const { debugEscrowHandler } = await import('../routes/campaigns.routes');

    getCampaignByIdMock.mockResolvedValue({
      id: 'campaign-1',
      status: 'active',
      goal: 1234,
      escrowAddress: 'ecash:qqescrow0000000000000000000000000000008n3hj3',
      recipientAddress: 'ecash:qqbeneficiary000000000000000000000008x6q4f',
    });
    getUtxosForAddressMock.mockRejectedValue(new Error('address-utxos-not-found'));

    const req = { params: { id: 'campaign-1' } } as any;
    const res = createMockRes();

    await debugEscrowHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      campaignId: 'campaign-1',
      status: 'active',
      goal: 1234,
      beneficiaryAddress: 'ecash:qqbeneficiary000000000000000000000008x6q4f',
      escrowAddress: 'ecash:qqescrow0000000000000000000000000000008n3hj3',
      escrowEqualsBeneficiary: false,
      utxoCount: 0,
      raised: 0,
      utxos: [],
    });
  });
});

function createMockRes() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
}
