import { describe, expect, it, vi } from 'vitest';
import { AutoPayoutService } from '../services/AutoPayoutService';

const campaign = {
  id: 'campaign-1',
  goal: '1000',
  status: 'funded',
  activationFeePaid: true,
  beneficiaryAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
  campaignAddress: 'ecash:pqx87w2wp47gcq2mx7nargg08vy74czg0sqdxccpss',
  payout: {
    txid: null,
    paidAt: null,
  },
};

describe('AutoPayoutService', () => {
  it('does not pay if goal is not reached', async () => {
    const service = new AutoPayoutService({
      campaignService: {
        getCampaign: vi.fn().mockResolvedValue(campaign),
        markPayoutComplete: vi.fn(),
      },
      getUtxosForAddress: vi.fn().mockResolvedValue([
        {
          txid: '11'.repeat(32),
          vout: 0,
          value: 999n,
          scriptPubKey: '51',
        },
      ]),
      buildPayoutTx: vi.fn(),
      broadcastRawTx: vi.fn(),
      canBroadcastBuiltPayout: vi.fn().mockReturnValue(false),
    });

    await expect(service.finalizeCampaign(campaign.id)).rejects.toThrow('goal-not-reached');
  });

  it('builds, broadcasts and marks paid out when the spend path is available', async () => {
    const markPayoutComplete = vi.fn();
    const buildPayoutTx = vi.fn().mockResolvedValue({
      unsignedTx: { inputs: [], outputs: [] },
      rawHex: 'deadbeef',
      fee: 0n,
      treasuryCut: 0n,
      beneficiaryAmount: 1000n,
    });
    const broadcastRawTx = vi.fn().mockResolvedValue({ txid: 'aa'.repeat(32) });
    const service = new AutoPayoutService({
      campaignService: {
        getCampaign: vi.fn().mockResolvedValue(campaign),
        markPayoutComplete,
      },
      getUtxosForAddress: vi.fn().mockResolvedValue([
        {
          txid: '11'.repeat(32),
          vout: 0,
          value: 1000n,
          scriptPubKey: '51',
        },
      ]),
      buildPayoutTx,
      broadcastRawTx,
      canBroadcastBuiltPayout: vi.fn().mockReturnValue(true),
    });

    const result = await service.finalizeCampaign(campaign.id);

    expect(buildPayoutTx).toHaveBeenCalledOnce();
    expect(broadcastRawTx).toHaveBeenCalledWith('deadbeef');
    expect(markPayoutComplete).toHaveBeenCalledWith(campaign.id, 'aa'.repeat(32), null);
    expect(result).toMatchObject({
      status: 'paid_out',
      campaignId: campaign.id,
      txid: 'aa'.repeat(32),
    });
  });

  it('does not repeat when campaign is already paid out', async () => {
    const paidCampaign = {
      ...campaign,
      status: 'paid_out',
      payout: {
        txid: 'bb'.repeat(32),
        paidAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const buildPayoutTx = vi.fn();
    const service = new AutoPayoutService({
      campaignService: {
        getCampaign: vi.fn().mockResolvedValue(paidCampaign),
        markPayoutComplete: vi.fn(),
      },
      getUtxosForAddress: vi.fn(),
      buildPayoutTx,
      broadcastRawTx: vi.fn(),
      canBroadcastBuiltPayout: vi.fn().mockReturnValue(false),
    });

    const result = await service.finalizeCampaign(campaign.id);

    expect(buildPayoutTx).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'already_paid_out',
      txid: 'bb'.repeat(32),
    });
  });
});
