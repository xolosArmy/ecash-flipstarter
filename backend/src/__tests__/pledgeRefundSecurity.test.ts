import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDbPath } from './helpers/testDbPath';
import { upsertCampaign } from '../db/SQLiteStore';

const CAMPAIGN_ID = 'campaign-secure-1';
const CAMPAIGN_SCRIPT = '76a914' + '11'.repeat(20) + '88ac';
const CAMPAIGN_ADDRESS = 'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
const CONTRIBUTOR_ADDRESS = 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59jrf5035';
const TXID = 'a'.repeat(64);


async function seedCampaign() {
  const { openDatabase, initializeDatabase } = await import('../db/SQLiteStore');
  const db = await openDatabase(process.env.TEYOLIA_SQLITE_PATH);
  await initializeDatabase(db);
  await upsertCampaign({
    id: CAMPAIGN_ID,
    name: 'Security campaign',
    description: 'test',
    goal: '5000',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    status: 'active',
    beneficiaryAddress: CONTRIBUTOR_ADDRESS,
    campaignAddress: CAMPAIGN_ADDRESS,
    covenantAddress: CAMPAIGN_ADDRESS,
    beneficiaryPubKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    contractVersion: 'legacy-placeholder',
  }, db);
}

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

describe('pledge and refund security', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.ENABLE_PUBLIC_REFUNDS;
    process.env.TEYOLIA_SQLITE_PATH = makeTestDbPath();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TEYOLIA_SQLITE_PATH;
    delete process.env.ENABLE_PUBLIC_REFUNDS;
  });

  async function importPledgeModules(args?: {
    txInfo?: { outputs: Array<{ valueSats: bigint; scriptPubKey: string }>; confirmations: number; height: number } | Error;
  }) {
    const getTransactionInfoMock = vi.fn();
    if (args?.txInfo instanceof Error) {
      getTransactionInfoMock.mockRejectedValue(args.txInfo);
    } else {
      getTransactionInfoMock.mockResolvedValue({
        txid: TXID,
        outputs: args?.txInfo?.outputs ?? [{ valueSats: 1000n, scriptPubKey: CAMPAIGN_SCRIPT }],
        confirmations: args?.txInfo?.confirmations ?? 1,
        height: args?.txInfo?.height ?? 100,
      });
    }

    vi.doMock('../services/CampaignService', () => ({
      CampaignService: vi.fn().mockImplementation(() => ({
        getCampaign: vi.fn().mockResolvedValue({
          id: CAMPAIGN_ID,
          goal: '5000',
          expirationTime: String(Date.now() + 60_000),
          campaignAddress: CAMPAIGN_ADDRESS,
          scriptPubKey: CAMPAIGN_SCRIPT,
          status: 'active',
        }),
      })),
      campaignStore: new Map(),
      covenantIndexInstance: {
        getCovenantRef: vi.fn(),
        updateValue: vi.fn(),
        setCovenantRef: vi.fn(),
      },
    }));
    vi.doMock('../blockchain/ecashClient', () => ({
      addressToScriptPubKey: vi.fn().mockResolvedValue(CAMPAIGN_SCRIPT),
      getTransactionInfo: getTransactionInfoMock,
      getUtxosForAddress: vi.fn().mockResolvedValue([]),
      broadcastRawTx: vi.fn(),
    }));

    await seedCampaign();
    const simplePledges = await import('../store/simplePledges');
    const pledgeRoutes = await import('../routes/pledge.routes');
    return { simplePledges, pledgeRoutes, getTransactionInfoMock };
  }

  async function saveIntentPledge(simplePledges: typeof import('../store/simplePledges'), pledgeId: string, amount = 1000) {
    await simplePledges.savePledge(CAMPAIGN_ID, {
      pledgeId,
      txid: null,
      wcOfferId: `wc-${pledgeId}`,
      amount,
      contributorAddress: CONTRIBUTOR_ADDRESS,
      timestamp: new Date().toISOString(),
      message: 'hola',
      status: 'intent',
    });
  }

  it('a pledge intent does not increase confirmed campaign total', async () => {
    await seedCampaign();
    const simplePledges = await import('../store/simplePledges');
    await saveIntentPledge(simplePledges, 'pledge-intent-1', 1200);

    expect(await simplePledges.getConfirmedTotalByCampaign(CAMPAIGN_ID)).toBe(0);
    expect(await simplePledges.getPendingTotalByCampaign(CAMPAIGN_ID)).toBe(1200);
  });

  it('a valid on-chain txid can mark a pledge as confirmed', async () => {
    const { simplePledges, pledgeRoutes } = await importPledgeModules();
    await saveIntentPledge(simplePledges, 'pledge-confirm-1', 1000);

    const res = createMockRes();
    await pledgeRoutes.confirmPledgeHandler({
      params: { id: CAMPAIGN_ID },
      body: { pledgeId: 'pledge-confirm-1', txid: TXID },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('confirmed');
    const pledge = await simplePledges.getPledgeById('pledge-confirm-1');
    expect(pledge?.status).toBe('confirmed');
    expect(await simplePledges.getConfirmedTotalByCampaign(CAMPAIGN_ID)).toBe(1000);
  });

  it('a nonexistent txid cannot mark a pledge as confirmed', async () => {
    const { simplePledges, pledgeRoutes } = await importPledgeModules({ txInfo: new Error('not-found') });
    await saveIntentPledge(simplePledges, 'pledge-missing-1', 1000);

    const res = createMockRes();
    await pledgeRoutes.confirmPledgeHandler({
      params: { id: CAMPAIGN_ID },
      body: { pledgeId: 'pledge-missing-1', txid: TXID },
    }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('txid-not-found');
    const pledge = await simplePledges.getPledgeById('pledge-missing-1');
    expect(pledge?.status).toBe('invalid');
    expect(await simplePledges.getConfirmedTotalByCampaign(CAMPAIGN_ID)).toBe(0);
  });

  it('a txid with insufficient amount cannot mark a pledge as confirmed', async () => {
    const { simplePledges, pledgeRoutes } = await importPledgeModules({
      txInfo: { outputs: [{ valueSats: 500n, scriptPubKey: CAMPAIGN_SCRIPT }], confirmations: 1, height: 100 },
    });
    await saveIntentPledge(simplePledges, 'pledge-low-1', 1000);

    const res = createMockRes();
    await pledgeRoutes.confirmPledgeHandler({
      params: { id: CAMPAIGN_ID },
      body: { pledgeId: 'pledge-low-1', txid: TXID },
    }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('pledge-amount-insufficient');
    expect((await simplePledges.getPledgeById('pledge-low-1'))?.status).toBe('invalid');
  });

  it('a txid paying the wrong campaign address or script cannot mark a pledge as confirmed', async () => {
    const { simplePledges, pledgeRoutes } = await importPledgeModules({
      txInfo: { outputs: [{ valueSats: 1000n, scriptPubKey: '76a914' + '22'.repeat(20) + '88ac' }], confirmations: 1, height: 100 },
    });
    await saveIntentPledge(simplePledges, 'pledge-wrong-script-1', 1000);

    const res = createMockRes();
    await pledgeRoutes.confirmPledgeHandler({
      params: { id: CAMPAIGN_ID },
      body: { pledgeId: 'pledge-wrong-script-1', txid: TXID },
    }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('campaign-output-mismatch');
    expect((await simplePledges.getPledgeById('pledge-wrong-script-1'))?.status).toBe('invalid');
  });

  it('the same txid cannot confirm two different pledges', async () => {
    const { simplePledges, pledgeRoutes } = await importPledgeModules();
    await saveIntentPledge(simplePledges, 'pledge-dup-1', 1000);
    await saveIntentPledge(simplePledges, 'pledge-dup-2', 1000);

    const first = createMockRes();
    await pledgeRoutes.confirmPledgeHandler({
      params: { id: CAMPAIGN_ID },
      body: { pledgeId: 'pledge-dup-1', txid: TXID },
    }, first);
    expect(first.statusCode).toBe(200);

    const second = createMockRes();
    await pledgeRoutes.confirmPledgeHandler({
      params: { id: CAMPAIGN_ID },
      body: { pledgeId: 'pledge-dup-2', txid: TXID },
    }, second);

    expect(second.statusCode).toBe(400);
    expect(second.body.error).toBe('txid-already-used');
    const secondPledge = await simplePledges.getPledgeById('pledge-dup-2');
    expect(secondPledge?.status).toBe('invalid');
    expect(secondPledge?.txid).toBeNull();
  });

  it('campaign totals only include confirmed pledges', async () => {
    await seedCampaign();
    const simplePledges = await import('../store/simplePledges');
    await simplePledges.savePledge(CAMPAIGN_ID, {
      pledgeId: 'pledge-total-intent',
      txid: null,
      wcOfferId: 'wc-intent',
      amount: 400,
      contributorAddress: CONTRIBUTOR_ADDRESS,
      timestamp: new Date().toISOString(),
      status: 'intent',
    });
    await simplePledges.savePledge(CAMPAIGN_ID, {
      pledgeId: 'pledge-total-confirmed',
      txid: 'b'.repeat(64),
      wcOfferId: 'wc-confirmed',
      amount: 600,
      contributorAddress: CONTRIBUTOR_ADDRESS,
      timestamp: new Date().toISOString(),
      status: 'confirmed',
      confirmedAt: new Date().toISOString(),
    });

    expect(await simplePledges.getConfirmedTotalByCampaign(CAMPAIGN_ID)).toBe(600);
    expect(await simplePledges.getPendingTotalByCampaign(CAMPAIGN_ID)).toBe(400);
  });

  it('public refunds default to disabled', async () => {
    vi.resetModules();
    vi.doMock('../services/RefundService', () => ({
      RefundService: vi.fn().mockImplementation(() => ({
        refundCampaign: vi.fn(),
      })),
    }));
    const refundRouter = (await import('../routes/refund.routes')).default;
    const app = express();
    app.use(express.json());
    app.use('/api', refundRouter);

    const res = await request(app)
      .post(`/api/campaign/${CAMPAIGN_ID}/refund`)
      .send({ pledgeId: 'pledge-1' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('public-refunds-disabled');
  });

  it('a refund request with an arbitrary refund address is rejected', async () => {
    process.env.ENABLE_PUBLIC_REFUNDS = 'true';
    vi.resetModules();
    vi.doMock('../services/RefundService', () => ({
      RefundService: vi.fn().mockImplementation(() => ({
        refundCampaign: vi.fn(),
      })),
    }));
    const refundRouter = (await import('../routes/refund.routes')).default;
    const app = express();
    app.use(express.json());
    app.use('/api', refundRouter);

    const res = await request(app)
      .post(`/api/campaign/${CAMPAIGN_ID}/refund`)
      .send({ pledgeId: 'pledge-1', refundAddress: 'ecash:qplladdressshouldfail0000000000000000000' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('refund-address-from-request-disabled');
  });

  it('a refund request with an arbitrary refund amount is rejected', async () => {
    process.env.ENABLE_PUBLIC_REFUNDS = 'true';
    vi.resetModules();
    vi.doMock('../services/RefundService', () => ({
      RefundService: vi.fn().mockImplementation(() => ({
        refundCampaign: vi.fn(),
      })),
    }));
    const refundRouter = (await import('../routes/refund.routes')).default;
    const app = express();
    app.use(express.json());
    app.use('/api', refundRouter);

    const res = await request(app)
      .post(`/api/campaign/${CAMPAIGN_ID}/refund`)
      .send({ pledgeId: 'pledge-1', refundAmount: 123456 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('refund-amount-from-request-disabled');
  });

  it('a refund can only target the original contributor address', async () => {
    vi.resetModules();
    vi.doUnmock('../services/RefundService');
    vi.doMock('../store/simplePledges', () => ({
      getPledgeById: vi.fn().mockResolvedValue({
        pledgeId: 'pledge-refund-1',
        campaignId: CAMPAIGN_ID,
        amount: 1000,
        contributorAddress: CONTRIBUTOR_ADDRESS,
        status: 'confirmed',
      }),
      getConfirmedTotalByCampaign: vi.fn().mockResolvedValue(1000),
      markPledgeRefunded: vi.fn().mockResolvedValue({ pledgeId: 'pledge-refund-1' }),
    }));
    vi.doMock('../services/CampaignService', () => ({
      CampaignService: vi.fn().mockImplementation(() => ({
        getCampaign: vi.fn().mockResolvedValue({
          id: CAMPAIGN_ID,
          goal: '5000',
          contractVersion: 'legacy-placeholder',
          campaignAddress: CAMPAIGN_ADDRESS,
          scriptPubKey: CAMPAIGN_SCRIPT,
          expirationTime: String(Date.now() - 60_000),
          status: 'expired',
        }),
      })),
      covenantIndexInstance: {
        getCovenantRef: vi.fn(),
        setCovenantRef: vi.fn(),
      },
    }));

    const buildRefundTx = vi.fn().mockResolvedValue({
      unsignedTx: { inputs: [{ txid: 'c'.repeat(64), vout: 0, value: 2500n, scriptPubKey: CAMPAIGN_SCRIPT }], outputs: [] },
      rawHex: 'refund-hex',
    });
    const { RefundService } = await import('../services/RefundService');
    const service = new RefundService({
      campaignService: new (await import('../services/CampaignService')).CampaignService(),
      getUtxosForAddress: vi.fn().mockResolvedValue([{ txid: 'c'.repeat(64), vout: 0, value: 2500n, scriptPubKey: CAMPAIGN_SCRIPT }]),
      buildRefundTx,
      broadcastRawTx: vi.fn().mockResolvedValue({ txid: 'd'.repeat(64) }),
    });

    await service.refundCampaign({ campaignId: CAMPAIGN_ID, pledgeId: 'pledge-refund-1' });

    expect(buildRefundTx).toHaveBeenCalledWith(expect.objectContaining({
      refundAddress: CONTRIBUTOR_ADDRESS,
      refundAmount: 1000n,
    }));
  });

  it('a finalized pledge is not refundable', async () => {
    vi.resetModules();
    vi.doUnmock('../services/RefundService');
    vi.doMock('../store/simplePledges', () => ({
      getPledgeById: vi.fn().mockResolvedValue({
        pledgeId: 'pledge-finalized-1',
        campaignId: CAMPAIGN_ID,
        amount: 1000,
        contributorAddress: CONTRIBUTOR_ADDRESS,
        status: 'finalized',
      }),
      getConfirmedTotalByCampaign: vi.fn(),
      markPledgeRefunded: vi.fn(),
    }));
    vi.doMock('../services/CampaignService', () => ({
      CampaignService: vi.fn().mockImplementation(() => ({
        getCampaign: vi.fn().mockResolvedValue({
          id: CAMPAIGN_ID,
          goal: '5000',
          contractVersion: 'legacy-placeholder',
          campaignAddress: CAMPAIGN_ADDRESS,
          scriptPubKey: CAMPAIGN_SCRIPT,
          expirationTime: String(Date.now() - 60_000),
          status: 'expired',
        }),
      })),
      covenantIndexInstance: {
        getCovenantRef: vi.fn(),
        setCovenantRef: vi.fn(),
      },
    }));

    const { RefundService } = await import('../services/RefundService');
    const service = new RefundService({
      campaignService: new (await import('../services/CampaignService')).CampaignService(),
      getUtxosForAddress: vi.fn(),
      buildRefundTx: vi.fn(),
      broadcastRawTx: vi.fn(),
    });

    await expect(service.refundCampaign({ campaignId: CAMPAIGN_ID, pledgeId: 'pledge-finalized-1' })).rejects.toThrow(
      'pledge-not-refundable-after-finalization',
    );
  });

  it('a refund cannot execute once the campaign goal has been reached', async () => {
    vi.resetModules();
    vi.doUnmock('../services/RefundService');
    vi.doMock('../store/simplePledges', () => ({
      getPledgeById: vi.fn().mockResolvedValue({
        pledgeId: 'pledge-goal-1',
        campaignId: CAMPAIGN_ID,
        amount: 1000,
        contributorAddress: CONTRIBUTOR_ADDRESS,
        status: 'confirmed',
      }),
      getConfirmedTotalByCampaign: vi.fn().mockResolvedValue(5000),
      markPledgeRefunded: vi.fn(),
    }));
    vi.doMock('../services/CampaignService', () => ({
      CampaignService: vi.fn().mockImplementation(() => ({
        getCampaign: vi.fn().mockResolvedValue({
          id: CAMPAIGN_ID,
          goal: '5000',
          contractVersion: 'legacy-placeholder',
          campaignAddress: CAMPAIGN_ADDRESS,
          scriptPubKey: CAMPAIGN_SCRIPT,
          expirationTime: String(Date.now() - 60_000),
          status: 'expired',
        }),
      })),
      covenantIndexInstance: {
        getCovenantRef: vi.fn(),
        setCovenantRef: vi.fn(),
      },
    }));

    const { RefundService } = await import('../services/RefundService');
    const service = new RefundService({
      campaignService: new (await import('../services/CampaignService')).CampaignService(),
      getUtxosForAddress: vi.fn(),
      buildRefundTx: vi.fn(),
      broadcastRawTx: vi.fn(),
    });

    await expect(service.refundCampaign({ campaignId: CAMPAIGN_ID, pledgeId: 'pledge-goal-1' })).rejects.toThrow(
      'refund-not-available-goal-reached',
    );
  });

  it('a refund cannot execute before campaign expiry or failure conditions', async () => {
    vi.resetModules();
    vi.doUnmock('../services/RefundService');
    vi.doMock('../store/simplePledges', () => ({
      getPledgeById: vi.fn().mockResolvedValue({
        pledgeId: 'pledge-refund-2',
        campaignId: CAMPAIGN_ID,
        amount: 1000,
        contributorAddress: CONTRIBUTOR_ADDRESS,
        status: 'confirmed',
      }),
      getConfirmedTotalByCampaign: vi.fn().mockResolvedValue(1000),
      markPledgeRefunded: vi.fn(),
    }));
    vi.doMock('../services/CampaignService', () => ({
      CampaignService: vi.fn().mockImplementation(() => ({
        getCampaign: vi.fn().mockResolvedValue({
          id: CAMPAIGN_ID,
          goal: '5000',
          contractVersion: 'legacy-placeholder',
          campaignAddress: CAMPAIGN_ADDRESS,
          scriptPubKey: CAMPAIGN_SCRIPT,
          expirationTime: String(Date.now() + 60_000),
          status: 'active',
        }),
      })),
      covenantIndexInstance: {
        getCovenantRef: vi.fn(),
        setCovenantRef: vi.fn(),
      },
    }));

    const { RefundService } = await import('../services/RefundService');
    const service = new RefundService({
      campaignService: new (await import('../services/CampaignService')).CampaignService(),
      getUtxosForAddress: vi.fn(),
      buildRefundTx: vi.fn(),
      broadcastRawTx: vi.fn(),
    });

    await expect(service.refundCampaign({ campaignId: CAMPAIGN_ID, pledgeId: 'pledge-refund-2' })).rejects.toThrow(
      'refund-not-available-before-expiry',
    );
  });
});
