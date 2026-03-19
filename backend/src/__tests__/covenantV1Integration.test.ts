import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { FinalizeService } from '../services/FinalizeService';
import { RefundService } from '../services/RefundService';
import { PledgeService } from '../services/PledgeService';
import { campaignStore, covenantIndexInstance } from '../services/CampaignService';
import { TEYOLIA_COVENANT_V1 } from '../covenants/scriptCompiler';

const beneficiaryPrivKeyHex = '01'.repeat(32);
const gasPrivKeyHex = '03'.repeat(32);
const oraclePrivKeyHex = '02'.repeat(32);
const beneficiaryPubKey = Buffer.from(secp256k1.getPublicKey(Buffer.from(beneficiaryPrivKeyHex, 'hex'), true)).toString('hex');
const oraclePubKey = Buffer.from(secp256k1.getPublicKey(Buffer.from(oraclePrivKeyHex, 'hex'), true)).toString('hex');

const campaignId = 'camp-v1';
const campaignAddress = 'ecash:pqx87w2wp47gcq2mx7nargg08vy74czg0sqdxccpss';
const beneficiaryAddress = 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk';
const refundAddress = 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59jrf5035';
const scriptPubKey = 'a914' + 'ab'.repeat(20) + '87';
const trackedCovenant = {
  campaignId,
  txid: '11'.repeat(32),
  vout: 0,
  value: 2500n,
  scriptHash: 'ab'.repeat(20),
  scriptPubKey,
};

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.TEYOLIA_BENEFICIARY_PRIVKEY = beneficiaryPrivKeyHex;
  process.env.TEYOLIA_GAS_WALLET_PRIVKEY = gasPrivKeyHex;
  process.env.TEYOLIA_GAS_WALLET_ADDRESS = beneficiaryAddress;
  process.env.TEYOLIA_REFUND_ORACLE_PRIVKEY = oraclePrivKeyHex;
  covenantIndexInstance.setCovenantRef({ ...trackedCovenant });
});

afterEach(() => {
  process.env = { ...originalEnv };
  covenantIndexInstance.deleteCampaign(campaignId);
  campaignStore.delete(campaignId);
});

describe('FinalizeService V1 integration', () => {
  it('passes V1 metadata to buildFinalizeTx and signs auxiliary gas inputs', async () => {
    const getCampaign = vi.fn().mockResolvedValue({
      id: campaignId,
      goal: '1000',
      activationFeePaid: true,
      status: 'funded',
      beneficiaryAddress,
      beneficiaryPubKey,
      contractVersion: TEYOLIA_COVENANT_V1,
      redeemScriptHex: '51',
      campaignAddress,
      scriptPubKey,
      payout: { txid: null, paidAt: null },
    });
    const markPayoutComplete = vi.fn().mockResolvedValue(undefined);
    const builtFinalizeTx = {
      unsignedTx: {
        inputs: [
          { ...trackedCovenant },
          {
            txid: '22'.repeat(32),
            vout: 1,
            value: 700n,
            scriptPubKey: '76a914' + '11'.repeat(20) + '88ac',
          },
        ],
        outputs: [{ value: 2000n, scriptPubKey: '76a914' + '22'.repeat(20) + '88ac' }],
      },
      rawHex: 'unsigned-finalize',
      fee: 500n,
    };
    const buildFinalizeTx = vi.fn().mockResolvedValue(builtFinalizeTx);
    const signP2pkhInput = vi.fn().mockReturnValue('signed-gas-script');
    const serializeTx = vi.fn().mockReturnValue('finalized-hex');
    const broadcastRawTx = vi.fn().mockResolvedValue({ txid: 'aa'.repeat(32) });
    const getUtxosForAddress = vi.fn()
      .mockResolvedValueOnce([{ ...trackedCovenant }])
      .mockResolvedValueOnce([
        {
          txid: '22'.repeat(32),
          vout: 1,
          value: 700n,
          scriptPubKey: '76a914' + '11'.repeat(20) + '88ac',
        },
      ]);

    const service = new FinalizeService({
      campaignService: { getCampaign, markPayoutComplete },
      getUtxosForAddress,
      buildFinalizeTx,
      signP2pkhInput,
      serializeTx,
      broadcastRawTx,
      legacyFinalizeCampaign: vi.fn(),
    });

    const result = await service.finalizeCampaign(campaignId);

    expect(buildFinalizeTx).toHaveBeenCalledWith(expect.objectContaining({
      covenantUtxo: expect.objectContaining({ txid: trackedCovenant.txid, vout: trackedCovenant.vout }),
      beneficiaryAddress,
      contractVersion: TEYOLIA_COVENANT_V1,
      redeemScriptHex: '51',
      beneficiaryPubKey,
      gasChangeAddress: beneficiaryAddress,
    }));
    expect(signP2pkhInput).toHaveBeenCalledWith(
      builtFinalizeTx.unsignedTx,
      Buffer.from(gasPrivKeyHex, 'hex'),
      1,
    );
    expect(broadcastRawTx).toHaveBeenCalledWith('finalized-hex');
    expect(markPayoutComplete).toHaveBeenCalledWith(campaignId, 'aa'.repeat(32), null);
    expect(result).toMatchObject({ status: 'paid_out', txid: 'aa'.repeat(32) });
  });

  it('falls back to the legacy finalize path for non-V1 campaigns', async () => {
    const legacyFinalizeCampaign = vi.fn().mockResolvedValue({
      status: 'paid_out',
      campaignId,
      goalSats: 1000n,
      raisedSats: 1000n,
      txid: 'bb'.repeat(32),
    });

    const service = new FinalizeService({
      campaignService: {
        getCampaign: vi.fn().mockResolvedValue({
          id: campaignId,
          goal: '1000',
          beneficiaryAddress,
          campaignAddress,
          contractVersion: 'legacy-placeholder',
          payout: { txid: null, paidAt: null },
        }),
        markPayoutComplete: vi.fn(),
      },
      getUtxosForAddress: vi.fn(),
      buildFinalizeTx: vi.fn(),
      signP2pkhInput: vi.fn(),
      serializeTx: vi.fn(),
      broadcastRawTx: vi.fn(),
      legacyFinalizeCampaign,
    });

    const result = await service.finalizeCampaign(campaignId);

    expect(legacyFinalizeCampaign).toHaveBeenCalledWith(campaignId);
    expect(result.txid).toBe('bb'.repeat(32));
  });

  it('fails clearly when V1 redeemScriptHex metadata is missing', async () => {
    const service = new FinalizeService({
      campaignService: {
        getCampaign: vi.fn().mockResolvedValue({
          id: campaignId,
          goal: '1000',
          activationFeePaid: true,
          beneficiaryAddress,
          beneficiaryPubKey,
          contractVersion: TEYOLIA_COVENANT_V1,
          campaignAddress,
          scriptPubKey,
          payout: { txid: null, paidAt: null },
        }),
        markPayoutComplete: vi.fn(),
      },
      getUtxosForAddress: vi.fn(),
      buildFinalizeTx: vi.fn(),
      signP2pkhInput: vi.fn(),
      serializeTx: vi.fn(),
      broadcastRawTx: vi.fn(),
      legacyFinalizeCampaign: vi.fn(),
    });

    await expect(service.finalizeCampaign(campaignId)).rejects.toThrow('v1-redeem-script-required');
  });
});

describe('RefundService V1 integration', () => {
  it('passes redeemScriptHex, expirationTime and oracle signature material to buildRefundTx', async () => {
    const buildRefundTx = vi.fn().mockResolvedValue({
      unsignedTx: {
        inputs: [{ ...trackedCovenant, sequence: 0xfffffffe }],
        outputs: [
          { value: 1000n, scriptPubKey: '76a914' + '33'.repeat(20) + '88ac' },
          { value: 1000n, scriptPubKey },
        ],
        locktime: 1735689600,
      },
      rawHex: 'refund-hex',
      fee: 500n,
    });
    const broadcastRawTx = vi.fn().mockResolvedValue({ txid: 'cc'.repeat(32) });
    const service = new RefundService({
      campaignService: {
        getCampaign: vi.fn().mockResolvedValue({
          id: campaignId,
          goal: '1000',
          contractVersion: TEYOLIA_COVENANT_V1,
          redeemScriptHex: '51',
          expirationTime: '1735689600',
          refundOraclePubKey: oraclePubKey,
          campaignAddress,
          scriptPubKey,
        }),
      },
      getUtxosForAddress: vi.fn().mockResolvedValue([{ ...trackedCovenant }]),
      buildRefundTx,
      broadcastRawTx,
    });

    const result = await service.refundCampaign(campaignId, refundAddress, 1000n);

    expect(buildRefundTx).toHaveBeenCalledWith(expect.objectContaining({
      covenantUtxo: expect.objectContaining({ txid: trackedCovenant.txid, vout: trackedCovenant.vout }),
      refundAddress,
      refundAmount: 1000n,
      contractVersion: TEYOLIA_COVENANT_V1,
      redeemScriptHex: '51',
      expirationTime: 1735689600n,
      refundOraclePrivKey: Buffer.from(oraclePrivKeyHex, 'hex'),
    }));
    expect(broadcastRawTx).toHaveBeenCalledWith('refund-hex');
    expect(result.txid).toBe('cc'.repeat(32));
  });

  it('keeps the legacy refund builder path for non-V1 campaigns', async () => {
    const buildRefundTx = vi.fn().mockResolvedValue({
      unsignedTx: { inputs: [{ ...trackedCovenant }], outputs: [] },
      rawHex: 'legacy-refund-hex',
    });
    const service = new RefundService({
      campaignService: {
        getCampaign: vi.fn().mockResolvedValue({
          id: campaignId,
          goal: '1000',
          contractVersion: 'legacy-placeholder',
          campaignAddress,
          scriptPubKey,
        }),
      },
      getUtxosForAddress: vi.fn().mockResolvedValue([{ ...trackedCovenant }]),
      buildRefundTx,
      broadcastRawTx: vi.fn().mockResolvedValue({ txid: 'dd'.repeat(32) }),
    });

    await service.createRefundTx(campaignId, refundAddress, 500n);

    expect(buildRefundTx).toHaveBeenCalledWith({
      covenantUtxo: expect.objectContaining({ txid: trackedCovenant.txid, vout: trackedCovenant.vout }),
      refundAddress,
      refundAmount: 500n,
    });
  });
});

describe('PledgeService V1 integration', () => {
  it('passes V1 metadata to buildPledgeTx', async () => {
    campaignStore.set(campaignId, {
      id: campaignId,
      name: 'Camp',
      description: '',
      goal: 1000n,
      expirationTime: 1735689600n,
      beneficiaryPubKey,
      contractVersion: TEYOLIA_COVENANT_V1,
      status: 'active',
      campaignAddress,
    });
    covenantIndexInstance.setCovenantRef({ ...trackedCovenant, value: 1000n });

    const buildPledgeTx = vi.fn().mockResolvedValue({
      unsignedTx: { inputs: [], outputs: [] },
      rawHex: 'pledge-hex',
      fee: 500n,
    });
    const service = new PledgeService({
      campaignService: {
        getCampaign: vi.fn().mockResolvedValue({
          id: campaignId,
          contractVersion: TEYOLIA_COVENANT_V1,
          redeemScriptHex: '51',
        }),
      },
      getUtxosForAddress: vi.fn().mockResolvedValue([
        {
          txid: '44'.repeat(32),
          vout: 0,
          value: 2000n,
          scriptPubKey: '76a914' + '44'.repeat(20) + '88ac',
        },
      ]),
      buildPledgeTx,
    });

    await service.createPledgeTx(campaignId, beneficiaryAddress, 1000n);

    expect(buildPledgeTx).toHaveBeenCalledWith(expect.objectContaining({
      contractVersion: TEYOLIA_COVENANT_V1,
      redeemScriptHex: '51',
      campaignScriptPubKey: scriptPubKey,
    }));
  });
});
