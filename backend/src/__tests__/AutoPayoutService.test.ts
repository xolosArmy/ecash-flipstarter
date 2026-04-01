import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEYOLIA_COVENANT_V1 } from '../covenants/scriptCompiler';
import { AutoPayoutService } from '../services/AutoPayoutService';

const campaign = {
  id: 'campaign-1',
  goal: '1000',
  status: 'funded',
  activationFeePaid: true,
  beneficiaryAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
  campaignAddress: 'ecash:pqx87w2wp47gcq2mx7nargg08vy74czg0sqdxccpss',
  redeemScriptHex: '51',
  payout: {
    txid: null,
    paidAt: null,
  },
};

const originalGasSeed = process.env.GAS_WALLET_SEED;
const originalGasAddress = process.env.GAS_WALLET_ADDRESS;

afterEach(() => {
  if (originalGasSeed === undefined) {
    delete process.env.GAS_WALLET_SEED;
  } else {
    process.env.GAS_WALLET_SEED = originalGasSeed;
  }

  if (originalGasAddress === undefined) {
    delete process.env.GAS_WALLET_ADDRESS;
  } else {
    process.env.GAS_WALLET_ADDRESS = originalGasAddress;
  }
});

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
      derivePrivKeyFromSeed: vi.fn(),
      signHybridPayoutTx: vi.fn(),
    });

    await expect(service.finalizeCampaign(campaign.id)).rejects.toThrow('goal-not-reached');
  });

  it('builds, signs, broadcasts and marks paid out', async () => {
    process.env.GAS_WALLET_SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    process.env.GAS_WALLET_ADDRESS = 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk';

    const markPayoutComplete = vi.fn();
    const builtTx = {
      unsignedTx: {
        inputs: [
          { txid: '11'.repeat(32), vout: 0, value: 1000n, scriptPubKey: '51' },
          {
            txid: '22'.repeat(32),
            vout: 1,
            value: 1500n,
            scriptPubKey: '76a914000000000000000000000000000000000000000088ac',
          },
        ],
        outputs: [{ value: 1000n, scriptPubKey: '51' }],
      },
      rawHex: 'unused',
      fee: 500n,
      treasuryCut: 0n,
      beneficiaryAmount: 1000n,
    };
    const buildPayoutTx = vi.fn().mockResolvedValue(builtTx);
    const broadcastRawTx = vi.fn().mockResolvedValue({ txid: 'aa'.repeat(32) });
    const derivePrivKeyFromSeed = vi.fn().mockResolvedValue(Buffer.alloc(32, 7));
    const signHybridPayoutTx = vi.fn().mockReturnValue('deadbeef');
    const getUtxosForAddress = vi.fn()
      .mockResolvedValueOnce([
        {
          txid: '11'.repeat(32),
          vout: 0,
          value: 1000n,
          scriptPubKey: '51',
        },
      ])
      .mockResolvedValueOnce([
        {
          txid: '22'.repeat(32),
          vout: 1,
          value: 1500n,
          scriptPubKey: '76a914000000000000000000000000000000000000000088ac',
        },
      ]);

    const service = new AutoPayoutService({
      campaignService: {
        getCampaign: vi.fn().mockResolvedValue(campaign),
        markPayoutComplete,
      },
      getUtxosForAddress,
      buildPayoutTx,
      broadcastRawTx,
      derivePrivKeyFromSeed,
      signHybridPayoutTx,
    });

    const result = await service.finalizeCampaign(campaign.id);

    expect(buildPayoutTx).toHaveBeenCalledWith({
      campaignUtxos: [
        {
          txid: '11'.repeat(32),
          vout: 0,
          value: 1000n,
          scriptPubKey: '51',
        },
      ],
      gasUtxo: {
        txid: '22'.repeat(32),
        vout: 1,
        value: 1500n,
        scriptPubKey: '76a914000000000000000000000000000000000000000088ac',
      },
      gasAddress: process.env.GAS_WALLET_ADDRESS,
      totalRaised: 1000n,
      beneficiaryAddress: campaign.beneficiaryAddress,
      fixedFee: 500n,
    });
    expect(derivePrivKeyFromSeed).toHaveBeenCalledWith(process.env.GAS_WALLET_SEED);
    expect(signHybridPayoutTx).toHaveBeenCalledWith(
      builtTx.unsignedTx,
      Buffer.alloc(32, 7),
      campaign.redeemScriptHex,
      1
    );
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
      derivePrivKeyFromSeed: vi.fn(),
      signHybridPayoutTx: vi.fn(),
    });

    const result = await service.finalizeCampaign(campaign.id);

    expect(buildPayoutTx).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'already_paid_out',
      txid: 'bb'.repeat(32),
    });
  });

  it('blocks rescue mode for signed V1 campaigns', async () => {
    process.env.GAS_WALLET_SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    process.env.GAS_WALLET_ADDRESS = 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk';

    const buildPayoutTx = vi.fn();
    const service = new AutoPayoutService({
      campaignService: {
        getCampaign: vi.fn().mockResolvedValue({
          ...campaign,
          contractVersion: TEYOLIA_COVENANT_V1,
        }),
        markPayoutComplete: vi.fn(),
      },
      getUtxosForAddress: vi.fn(),
      buildPayoutTx,
      broadcastRawTx: vi.fn(),
      derivePrivKeyFromSeed: vi.fn(),
      signHybridPayoutTx: vi.fn(),
    });

    await expect(service.finalizeCampaign(campaign.id)).rejects.toThrow('auto-payout-unsupported-for-v1');
    expect(buildPayoutTx).not.toHaveBeenCalled();
  });
});
