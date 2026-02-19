import { beforeEach, describe, expect, it, vi } from 'vitest';

const createCampaignMock = vi.fn();

vi.mock('../services/CampaignService', () => ({
  CampaignService: vi.fn().mockImplementation(() => ({
    createCampaign: createCampaignMock,
  })),
  syncCampaignStoreFromDiskCampaigns: vi.fn(),
}));

vi.mock('../store/campaignPersistence', () => ({
  saveCampaignsToDisk: vi.fn(),
}));

vi.mock('../db/SQLiteStore', () => ({
  upsertCampaign: vi.fn(),
}));

describe('createCampaignHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores client provided id and returns server generated id', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1777777777777);
    const { createCampaignHandler } = await import('../routes/campaigns.routes');

    createCampaignMock.mockResolvedValue({
      id: 'campaign-1777777777777',
      name: 'Server campaign',
      status: 'pending_fee',
    });

    const req = {
      body: {
        id: 'campaign-local-temp-id',
        name: 'Server campaign',
        goal: 123,
        beneficiaryAddress: 'ecash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqu08dsy2',
      },
    } as any;
    const res = createMockRes();

    await createCampaignHandler(req, res);

    expect(createCampaignMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'campaign-1777777777777',
      name: 'Server campaign',
    }));
    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBe('campaign-1777777777777');
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
