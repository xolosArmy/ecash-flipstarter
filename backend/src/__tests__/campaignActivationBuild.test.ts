import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCampaignMock = vi.fn();
const setActivationOfferMock = vi.fn();

vi.mock('../services/CampaignService', () => ({
  CampaignService: class {
    getCampaign = getCampaignMock;
    setActivationOffer = setActivationOfferMock;
  },
}));

vi.mock('../blockchain/ecashClient', () => ({
  getUtxosForAddress: vi.fn(),
  addressToScriptPubKey: vi.fn(),
  getTransactionOutputs: vi.fn(),
}));

vi.mock('../blockchain/txBuilder', () => ({
  buildPayoutTx: vi.fn(),
}));

vi.mock('../services/WalletConnectOfferStore', () => ({
  walletConnectOfferStore: {
    createOffer: vi.fn().mockReturnValue({
      offerId: 'offer-123',
    }),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  getCampaignMock.mockResolvedValue({
    id: 'camp-1',
    name: 'Campaign',
    goal: '1000',
    expirationTime: String(Date.now() + 86_400_000),
    beneficiaryAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
    activationFeeRequired: 800000,
    activationFeePaid: false,
  });
});

describe('buildActivationHandler', () => {
  it('returns intent outputs and persists activation offer', async () => {
    const { buildActivationHandler } = (await import('../routes/campaigns.routes')) as {
      buildActivationHandler: (req: any, res: any) => Promise<void>;
    };
    const req = {
      params: { id: 'camp-1' },
      body: { payerAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk' },
    };
    const res = createMockRes();

    await buildActivationHandler(req as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body.mode).toBe('intent');
    expect(res.body.outputs).toEqual([
      {
        address: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
        valueSats: 80000000,
      },
    ]);
    expect(setActivationOfferMock).toHaveBeenCalledWith(
      'camp-1',
      'offer-123',
      'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
      {
        mode: 'intent',
        outputs: [
          {
            address: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
            valueSats: 80000000,
          },
        ],
        treasuryAddressUsed: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
      },
    );
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
