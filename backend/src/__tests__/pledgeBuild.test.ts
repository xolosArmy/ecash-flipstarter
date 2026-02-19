import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCampaignStatusByIdMock = vi.fn();
const ensureCampaignCovenantMock = vi.fn();
const createWalletConnectPledgeOfferMock = vi.fn();

const canonicalEscrow = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk';
const mismatchedAddress = 'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
let campaignRecord: Record<string, string>;

vi.mock('../routes/campaigns.routes', () => ({
  getCampaignStatusById: getCampaignStatusByIdMock,
}));

vi.mock('../services/CampaignService', () => ({
  CampaignService: vi.fn().mockImplementation(() => ({
    resolveCampaignId: vi.fn(async (id: string) => id),
    ensureCampaignCovenant: ensureCampaignCovenantMock,
    getCampaign: vi.fn(async () => campaignRecord),
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
      campaignAddress: canonicalEscrow,
    });
    campaignRecord = {
      campaignAddress: canonicalEscrow,
      escrowAddress: canonicalEscrow,
      covenantAddress: canonicalEscrow,
    };
  });

  it('returns 400 when contributorAddress is missing', async () => {
    const { createPledgeBuildHandler } = await import('../routes/pledge.build');
    const res = createMockRes();

    await createPledgeBuildHandler({ params: { id: 'camp-1' }, body: { amountXec: 10 } } as any, res as any);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'contributorAddress-required' });
  });

  it('returns escrow-address-mismatch when campaign fields diverge', async () => {
    campaignRecord = {
      campaignAddress: mismatchedAddress,
      escrowAddress: canonicalEscrow,
      covenantAddress: canonicalEscrow,
    };

    const { createPledgeBuildHandler } = await import('../routes/pledge.build');
    const res = createMockRes();

    await createPledgeBuildHandler({
      params: { id: 'camp-1' },
      body: { contributorAddress: canonicalEscrow, amountXec: 12.34 },
    } as any, res as any);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      error: 'escrow-address-mismatch',
      canonicalEscrow,
      campaignAddress: mismatchedAddress,
      campaignId: 'camp-1',
    });
  });

  it('returns intent-only offer payload for walletconnect (outputs only)', async () => {
    createWalletConnectPledgeOfferMock.mockResolvedValue({
      mode: 'intent',
      outputs: [{ address: canonicalEscrow, valueSats: 1234 }],
      unsignedTx: {
        inputs: [{ txid: 'a'.repeat(64), vout: 1, value: '1337', scriptPubKey: '76a914' + '11'.repeat(20) + '88ac' }],
        outputs: [{ value: '1234', scriptPubKey: 'a914' + 'cd'.repeat(20) + '87' }],
      },
      wcOfferId: 'offer-1',
    });

    const { createPledgeBuildHandler } = await import('../routes/pledge.build');
    const res = createMockRes();

    await createPledgeBuildHandler({
      params: { id: 'camp-1' },
      body: { contributorAddress: 'ecash:qpsqa7cj5mup8mx0zvt34z7xyp2jztvdds67wajntk', amountXec: 12.34, message: 'hola' },
    } as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(res.body.escrowAddress).toBe(canonicalEscrow);
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
