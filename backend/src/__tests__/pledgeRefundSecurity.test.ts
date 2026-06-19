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
    const campaignRoutes = await import('../routes/campaigns.routes');
    return { simplePledges, pledgeRoutes, campaignRoutes, getTransactionInfoMock };
  }

  function createCampaignApp(campaignRoutes: typeof import('../routes/campaigns.routes')) {
    const app = express();
    app.use(express.json());
    app.use('/api', campaignRoutes.default);
    return app;
  }

  async function countAuditEvents(event: string) {
    const { getDb } = await import('../store/db');
    const db = await getDb();
    const row = await db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM audit_logs WHERE campaignId = ? AND event = ?',
      [CAMPAIGN_ID, event],
    );
    return Number(row?.count ?? 0);
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

  it('cannot_reconfirm_confirmed_with_different_txid', async () => {
    const { simplePledges, pledgeRoutes, getTransactionInfoMock } = await importPledgeModules();
    const confirmedAt = new Date().toISOString();
    await simplePledges.savePledge(CAMPAIGN_ID, {
      pledgeId: 'pledge-confirmed-terminal',
      txid: TXID,
      wcOfferId: 'wc-confirmed-terminal',
      amount: 1000,
      contributorAddress: CONTRIBUTOR_ADDRESS,
      timestamp: new Date().toISOString(),
      status: 'confirmed',
      confirmedAt,
    });

    const res = createMockRes();
    await pledgeRoutes.confirmPledgeHandler({
      params: { id: CAMPAIGN_ID },
      body: { pledgeId: 'pledge-confirmed-terminal', txid: 'b'.repeat(64) },
    }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'pledge-status-not-confirmable' });
    expect(getTransactionInfoMock).not.toHaveBeenCalled();
    expect(await simplePledges.getPledgeById('pledge-confirmed-terminal')).toMatchObject({
      status: 'confirmed',
      txid: TXID,
      confirmedAt,
    });
  });

  it('cannot_reconfirm_finalized_with_different_txid', async () => {
    const { simplePledges, pledgeRoutes, getTransactionInfoMock } = await importPledgeModules();
    await simplePledges.savePledge(CAMPAIGN_ID, {
      pledgeId: 'pledge-finalized-terminal',
      txid: TXID,
      wcOfferId: 'wc-finalized-terminal',
      amount: 1000,
      contributorAddress: CONTRIBUTOR_ADDRESS,
      timestamp: new Date().toISOString(),
      status: 'finalized',
      confirmedAt: new Date().toISOString(),
    });

    const res = createMockRes();
    await pledgeRoutes.confirmPledgeHandler({
      params: { id: CAMPAIGN_ID },
      body: { pledgeId: 'pledge-finalized-terminal', txid: 'b'.repeat(64) },
    }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'pledge-status-not-confirmable' });
    expect(getTransactionInfoMock).not.toHaveBeenCalled();
    expect(await simplePledges.getPledgeById('pledge-finalized-terminal')).toMatchObject({
      status: 'finalized',
      txid: TXID,
    });
  });

  it('cannot_reconfirm_refunded_pledge', async () => {
    const { simplePledges, pledgeRoutes, getTransactionInfoMock } = await importPledgeModules();
    const refundTxid = 'c'.repeat(64);
    const refundedAt = new Date().toISOString();
    await simplePledges.savePledge(CAMPAIGN_ID, {
      pledgeId: 'pledge-refunded-terminal',
      txid: TXID,
      wcOfferId: 'wc-refunded-terminal',
      amount: 1000,
      contributorAddress: CONTRIBUTOR_ADDRESS,
      timestamp: new Date().toISOString(),
      status: 'refunded',
      confirmedAt: new Date(Date.now() - 60_000).toISOString(),
      refundTxid,
      refundedAt,
    });

    const res = createMockRes();
    await pledgeRoutes.confirmPledgeHandler({
      params: { id: CAMPAIGN_ID },
      body: { pledgeId: 'pledge-refunded-terminal', txid: 'b'.repeat(64) },
    }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'pledge-status-not-confirmable' });
    expect(getTransactionInfoMock).not.toHaveBeenCalled();
    expect(await simplePledges.getPledgeById('pledge-refunded-terminal')).toMatchObject({
      status: 'refunded',
      txid: TXID,
      refundTxid,
      refundedAt,
    });
  });

  it('reconfirm_confirmed_same_txid_is_idempotent', async () => {
    const { simplePledges, pledgeRoutes, getTransactionInfoMock } = await importPledgeModules();
    const confirmedAt = new Date().toISOString();
    await simplePledges.savePledge(CAMPAIGN_ID, {
      pledgeId: 'pledge-confirmed-idempotent',
      txid: TXID,
      wcOfferId: 'wc-confirmed-idempotent',
      amount: 1000,
      contributorAddress: CONTRIBUTOR_ADDRESS,
      timestamp: new Date().toISOString(),
      status: 'confirmed',
      confirmedAt,
    });
    const auditCountBefore = await countAuditEvents('PLEDGE_CONFIRMED');

    const res = createMockRes();
    await pledgeRoutes.confirmPledgeHandler({
      params: { id: CAMPAIGN_ID },
      body: { pledgeId: 'pledge-confirmed-idempotent', txid: TXID },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      status: 'confirmed',
      pledgeId: 'pledge-confirmed-idempotent',
      txid: TXID,
    });
    expect(getTransactionInfoMock).not.toHaveBeenCalled();
    expect(await countAuditEvents('PLEDGE_CONFIRMED')).toBe(auditCountBefore);
    expect(await simplePledges.getPledgeById('pledge-confirmed-idempotent')).toMatchObject({
      status: 'confirmed',
      txid: TXID,
      confirmedAt,
    });
  });

  it('confirm_requires_pledgeId_or_wcOfferId', async () => {
    const { simplePledges, pledgeRoutes, getTransactionInfoMock } = await importPledgeModules();
    await saveIntentPledge(simplePledges, 'pledge-identity-required', 1000);

    const res = createMockRes();
    await pledgeRoutes.confirmPledgeHandler({
      params: { id: CAMPAIGN_ID },
      body: { txid: TXID },
    }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'missing-pledge-identity' });
    expect(getTransactionInfoMock).not.toHaveBeenCalled();
    expect((await simplePledges.getPledgeById('pledge-identity-required'))?.status).toBe('intent');
  });

  it('a txid not indexed immediately after broadcast stays pending verification', async () => {
    const { simplePledges, pledgeRoutes } = await importPledgeModules({ txInfo: new Error('not-found') });
    await saveIntentPledge(simplePledges, 'pledge-missing-1', 1000);

    const res = createMockRes();
    await pledgeRoutes.confirmPledgeHandler({
      params: { id: CAMPAIGN_ID },
      body: { pledgeId: 'pledge-missing-1', txid: TXID },
    }, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({
      status: 'pending_verification',
      reason: 'txid-not-found',
      pledgeId: 'pledge-missing-1',
      txid: TXID,
      pledgeStatus: 'broadcasted',
    });
    const pledge = await simplePledges.getPledgeById('pledge-missing-1');
    expect(pledge?.status).toBe('broadcasted');
    expect(pledge?.txid).toBe(TXID);
    expect(await simplePledges.getConfirmedTotalByCampaign(CAMPAIGN_ID)).toBe(0);
    expect(await simplePledges.getPendingTotalByCampaign(CAMPAIGN_ID)).toBe(1000);
  });

  it('a later valid Chronik lookup promotes a pending pledge to confirmed', async () => {
    const { simplePledges, pledgeRoutes, getTransactionInfoMock } = await importPledgeModules({ txInfo: new Error('not-found') });
    await saveIntentPledge(simplePledges, 'pledge-promote-1', 1000);

    const pending = createMockRes();
    await pledgeRoutes.confirmPledgeHandler({
      params: { id: CAMPAIGN_ID },
      body: { pledgeId: 'pledge-promote-1', txid: TXID },
    }, pending);
    expect(pending.statusCode).toBe(202);

    getTransactionInfoMock.mockReset();
    getTransactionInfoMock.mockResolvedValue({
      txid: TXID,
      outputs: [{ valueSats: 1000n, scriptPubKey: CAMPAIGN_SCRIPT }],
      confirmations: 1,
      height: 100,
    });

    const confirmed = createMockRes();
    await pledgeRoutes.confirmPledgeHandler({
      params: { id: CAMPAIGN_ID },
      body: { pledgeId: 'pledge-promote-1', txid: TXID },
    }, confirmed);

    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.body.status).toBe('confirmed');
    const pledge = await simplePledges.getPledgeById('pledge-promote-1');
    expect(pledge?.status).toBe('confirmed');
    expect(await simplePledges.getConfirmedTotalByCampaign(CAMPAIGN_ID)).toBe(1000);
    expect(await simplePledges.getPendingTotalByCampaign(CAMPAIGN_ID)).toBe(0);
  });

  it('campaign GET promotes a seen_mempool pledge after Chronik reports confirmations', async () => {
    const { simplePledges, campaignRoutes } = await importPledgeModules();
    await simplePledges.savePledge(CAMPAIGN_ID, {
      pledgeId: 'pledge-auto-seen-1',
      txid: TXID,
      wcOfferId: 'wc-auto-seen-1',
      amount: 1000,
      contributorAddress: CONTRIBUTOR_ADDRESS,
      timestamp: new Date().toISOString(),
      status: 'seen_mempool',
    });

    const res = await request(createCampaignApp(campaignRoutes)).get(`/api/campaigns/${CAMPAIGN_ID}`);

    expect(res.status).toBe(200);
    const pledge = await simplePledges.getPledgeById('pledge-auto-seen-1');
    expect(pledge?.status).toBe('confirmed');
    expect(pledge?.confirmedAt).toBeTruthy();
    expect(pledge?.statusReason).toBeNull();
    expect(await simplePledges.getConfirmedTotalByCampaign(CAMPAIGN_ID)).toBe(1000);
    expect(await simplePledges.getPendingTotalByCampaign(CAMPAIGN_ID)).toBe(0);
    expect(await countAuditEvents('PLEDGE_CONFIRMED')).toBe(1);
  });

  it('legacy invalid txid-not-found pledge is recovered when Chronik later finds a valid tx', async () => {
    const { simplePledges, campaignRoutes } = await importPledgeModules();
    await simplePledges.savePledge(CAMPAIGN_ID, {
      pledgeId: 'pledge-legacy-recover-1',
      txid: TXID,
      wcOfferId: 'wc-legacy-recover-1',
      amount: 1000,
      contributorAddress: CONTRIBUTOR_ADDRESS,
      timestamp: new Date().toISOString(),
      status: 'invalid',
      statusReason: 'txid-not-found',
    });

    const res = await request(createCampaignApp(campaignRoutes)).get(`/api/campaigns/${CAMPAIGN_ID}`);

    expect(res.status).toBe(200);
    const pledge = await simplePledges.getPledgeById('pledge-legacy-recover-1');
    expect(pledge?.status).toBe('confirmed');
    expect(pledge?.statusReason).toBeNull();
    expect(await simplePledges.getConfirmedTotalByCampaign(CAMPAIGN_ID)).toBe(1000);
  });

  it('broadcasted txid-not-found remains pending when Chronik still cannot find it', async () => {
    const { simplePledges, campaignRoutes } = await importPledgeModules({ txInfo: new Error('not-found') });
    await simplePledges.savePledge(CAMPAIGN_ID, {
      pledgeId: 'pledge-auto-missing-1',
      txid: TXID,
      wcOfferId: 'wc-auto-missing-1',
      amount: 1000,
      contributorAddress: CONTRIBUTOR_ADDRESS,
      timestamp: new Date().toISOString(),
      status: 'broadcasted',
      statusReason: 'txid-not-found',
    });

    const res = await request(createCampaignApp(campaignRoutes)).get(`/api/campaigns/${CAMPAIGN_ID}`);

    expect(res.status).toBe(200);
    const pledge = await simplePledges.getPledgeById('pledge-auto-missing-1');
    expect(pledge?.status).toBe('broadcasted');
    expect(pledge?.statusReason).toBe('txid-not-found');
    expect(await simplePledges.getConfirmedTotalByCampaign(CAMPAIGN_ID)).toBe(0);
    expect(await simplePledges.getPendingTotalByCampaign(CAMPAIGN_ID)).toBe(1000);
  });

  it('wrong destination remains invalid during automatic reconciliation', async () => {
    const { simplePledges, campaignRoutes } = await importPledgeModules({
      txInfo: { outputs: [{ valueSats: 1000n, scriptPubKey: '76a914' + '22'.repeat(20) + '88ac' }], confirmations: 1, height: 100 },
    });
    await simplePledges.savePledge(CAMPAIGN_ID, {
      pledgeId: 'pledge-auto-wrong-script-1',
      txid: TXID,
      wcOfferId: 'wc-auto-wrong-script-1',
      amount: 1000,
      contributorAddress: CONTRIBUTOR_ADDRESS,
      timestamp: new Date().toISOString(),
      status: 'seen_mempool',
    });

    const res = await request(createCampaignApp(campaignRoutes)).get(`/api/campaigns/${CAMPAIGN_ID}`);

    expect(res.status).toBe(200);
    const pledge = await simplePledges.getPledgeById('pledge-auto-wrong-script-1');
    expect(pledge?.status).toBe('invalid');
    expect(pledge?.statusReason).toBe('campaign-output-mismatch');
  });

  it('insufficient amount remains invalid during automatic reconciliation', async () => {
    const { simplePledges, campaignRoutes } = await importPledgeModules({
      txInfo: { outputs: [{ valueSats: 500n, scriptPubKey: CAMPAIGN_SCRIPT }], confirmations: 1, height: 100 },
    });
    await simplePledges.savePledge(CAMPAIGN_ID, {
      pledgeId: 'pledge-auto-low-1',
      txid: TXID,
      wcOfferId: 'wc-auto-low-1',
      amount: 1000,
      contributorAddress: CONTRIBUTOR_ADDRESS,
      timestamp: new Date().toISOString(),
      status: 'seen_mempool',
    });

    const res = await request(createCampaignApp(campaignRoutes)).get(`/api/campaigns/${CAMPAIGN_ID}`);

    expect(res.status).toBe(200);
    const pledge = await simplePledges.getPledgeById('pledge-auto-low-1');
    expect(pledge?.status).toBe('invalid');
    expect(pledge?.statusReason).toBe('pledge-amount-insufficient');
  });

  it('confirmed total increases and pending total decreases only after confirmation', async () => {
    const { simplePledges, campaignRoutes, getTransactionInfoMock } = await importPledgeModules({
      txInfo: { outputs: [{ valueSats: 1000n, scriptPubKey: CAMPAIGN_SCRIPT }], confirmations: 0, height: -1 },
    });
    await simplePledges.savePledge(CAMPAIGN_ID, {
      pledgeId: 'pledge-auto-totals-1',
      txid: TXID,
      wcOfferId: 'wc-auto-totals-1',
      amount: 1000,
      contributorAddress: CONTRIBUTOR_ADDRESS,
      timestamp: new Date().toISOString(),
      status: 'broadcasted',
      statusReason: 'txid-not-found',
    });

    const app = createCampaignApp(campaignRoutes);
    expect((await request(app).get(`/api/campaigns/${CAMPAIGN_ID}`)).status).toBe(200);
    expect(await simplePledges.getConfirmedTotalByCampaign(CAMPAIGN_ID)).toBe(0);
    expect(await simplePledges.getPendingTotalByCampaign(CAMPAIGN_ID)).toBe(1000);

    getTransactionInfoMock.mockResolvedValue({
      txid: TXID,
      outputs: [{ valueSats: 1000n, scriptPubKey: CAMPAIGN_SCRIPT }],
      confirmations: 1,
      height: 100,
    });

    expect((await request(app).get(`/api/campaigns/${CAMPAIGN_ID}`)).status).toBe(200);
    expect(await simplePledges.getConfirmedTotalByCampaign(CAMPAIGN_ID)).toBe(1000);
    expect(await simplePledges.getPendingTotalByCampaign(CAMPAIGN_ID)).toBe(0);
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
      reconcilePendingPledgesForCampaign: vi.fn().mockResolvedValue({ inspected: 0, updated: 0, confirmed: 0, invalid: 0 }),
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
      reconcilePendingPledgesForCampaign: vi.fn().mockResolvedValue({ inspected: 0, updated: 0, confirmed: 0, invalid: 0 }),
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
      reconcilePendingPledgesForCampaign: vi.fn().mockResolvedValue({ inspected: 0, updated: 0, confirmed: 0, invalid: 0 }),
    });

    await expect(service.refundCampaign({ campaignId: CAMPAIGN_ID, pledgeId: 'pledge-goal-1' })).rejects.toThrow(
      'refund-not-available-goal-reached',
    );
  });

  it('refund_reconciles_before_goal_check', async () => {
    vi.resetModules();
    vi.doUnmock('../services/RefundService');
    const getConfirmedTotalByCampaign = vi.fn().mockResolvedValue(5000);
    vi.doMock('../store/simplePledges', () => ({
      getPledgeById: vi.fn().mockResolvedValue({
        pledgeId: 'pledge-reconcile-goal',
        campaignId: CAMPAIGN_ID,
        amount: 1000,
        contributorAddress: CONTRIBUTOR_ADDRESS,
        status: 'confirmed',
      }),
      getConfirmedTotalByCampaign,
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

    const reconcile = vi.fn().mockResolvedValue({ inspected: 1, updated: 1, confirmed: 1, invalid: 0 });
    const buildRefundTx = vi.fn();
    const { RefundService } = await import('../services/RefundService');
    const service = new RefundService({
      campaignService: new (await import('../services/CampaignService')).CampaignService(),
      getUtxosForAddress: vi.fn(),
      buildRefundTx,
      broadcastRawTx: vi.fn(),
      reconcilePendingPledgesForCampaign: reconcile,
    });

    await expect(service.refundCampaign({ campaignId: CAMPAIGN_ID, pledgeId: 'pledge-reconcile-goal' })).rejects.toThrow(
      'refund-not-available-goal-reached',
    );
    expect(reconcile).toHaveBeenCalledWith(CAMPAIGN_ID);
    expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(getConfirmedTotalByCampaign.mock.invocationCallOrder[0]);
    expect(buildRefundTx).not.toHaveBeenCalled();
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
      reconcilePendingPledgesForCampaign: vi.fn().mockResolvedValue({ inspected: 0, updated: 0, confirmed: 0, invalid: 0 }),
    });

    await expect(service.refundCampaign({ campaignId: CAMPAIGN_ID, pledgeId: 'pledge-refund-2' })).rejects.toThrow(
      'refund-not-available-before-expiry',
    );
  });
});
