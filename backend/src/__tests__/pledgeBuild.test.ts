import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCampaignStatusByIdMock = vi.fn();
const ensureCampaignCovenantMock = vi.fn();
const createWalletConnectPledgeOfferMock = vi.fn();

vi.mock('../routes/campaigns.routes', () => ({
  getCampaignStatusById: getCampaignStatusByIdMock,
}));

vi.mock('../services/CampaignService', () => ({
  CampaignService: vi.fn().mockImplementation(() => ({
    resolveCampaignId: vi.fn(async (id: string) => id),
    ensureCampaignCovenant: ensureCampaignCovenantMock,
    getCampaign: vi.fn(async () => ({
      campaignAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
      escrowAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
      covenantAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
    })),
  })),
}));

vi.mock('../services/PledgeOfferService', () => ({
  createWalletConnectPledgeOffer: createWalletConnectPledgeOfferMock,
}));

describe('createPledgeBuildHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCampaignStatusByIdMock.mockResolvedValue('active');
    ensureCampaignCovenantMock.mockResolvedValue({
      txid: '',
      vout: 0,
      value: 0n,
      scriptHash: 'ab'.repeat(20),
      scriptPubKey: 'a914' + 'cd'.repeat(20) + '87',
      campaignAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
    });
  });

  it('returns 400 when contributorAddress is missing', async () => {
    const { createPledgeBuildHandler } = await import('../routes/pledge.build');
    const res = createMockRes();

    await createPledgeBuildHandler(
      {
        params: { id: 'camp-1' },
        body: { amountXec: 10 },
      } as any,
      res as any,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'contributorAddress-required' });
  });

  it('returns intent-only offer payload for walletconnect (outputs only)', async () => {
    createWalletConnectPledgeOfferMock.mockResolvedValue({
      mode: 'intent',
      outputs: [{ address: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk', valueSats: 1234 }],
      unsignedTx: {
        inputs: [{ txid: 'a'.repeat(64), vout: 1, value: '1337', scriptPubKey: '76a914' + '11'.repeat(20) + '88ac' }],
        outputs: [{ value: '1234', scriptPubKey: 'a914' + 'cd'.repeat(20) + '87' }],
      },
      wcOfferId: 'offer-1',
    });

    const { createPledgeBuildHandler } = await import('../routes/pledge.build');
    const res = createMockRes();

    await createPledgeBuildHandler(
      {
        params: { id: 'camp-1' },
        body: {
          contributorAddress: 'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
          amountXec: 12.34,
          message: 'hola',
        },
      } as any,
      res as any,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.mode).toBe('intent');
    expect(res.body.outputs).toEqual([
      { address: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk', valueSats: 1234 },
    ]);
    expect(res.body.escrowAddress).toBe('ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk');
    expect(res.body.inputsUsed).toBeUndefined();
    expect(res.body.outpoints).toBeUndefined();
    expect(createWalletConnectPledgeOfferMock).toHaveBeenCalledWith(
      'camp-1',
      'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
      1234n,
      expect.objectContaining({
        campaignAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
        message: 'hola',
      }),
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
