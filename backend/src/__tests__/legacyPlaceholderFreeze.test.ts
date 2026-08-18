import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import {
  getCampaignById,
  initializeDatabase,
  openDatabase,
  upsertCampaign,
  type StoredCampaign,
} from '../db/SQLiteStore';
import {
  CampaignService,
  syncCampaignStoreFromDiskCampaigns,
} from '../services/CampaignService';
import { FinalizeService } from '../services/FinalizeService';
import { AutoPayoutService } from '../services/AutoPayoutService';
import { RefundService } from '../services/RefundService';
import { PledgeService } from '../services/PledgeService';
import { PledgeVerificationService } from '../services/PledgeVerificationService';
import { walletConnectOfferStore } from '../services/WalletConnectOfferStore';
import { makeTestDbPath } from './helpers/testDbPath';
import * as ecashClient from '../blockchain/ecashClient';
import {
  LEGACY_PLACEHOLDER_DISABLED_CODE,
  LEGACY_PLACEHOLDER_DISABLED_STATUS,
} from '../security/legacyPlaceholderFreeze';

const LEGACY_CAMPAIGN_ID = 'campaign-legacy-placeholder-freeze';
const BENEFICIARY_ADDRESS = 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk';
const CONTRIBUTOR_ADDRESS = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk';
const LEGACY_RECORD: StoredCampaign = {
  id: LEGACY_CAMPAIGN_ID,
  name: 'Historical legacy placeholder',
  description: 'Read-only security freeze fixture',
  goal: '1000',
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  createdAt: new Date().toISOString(),
  status: 'active',
  beneficiaryAddress: BENEFICIARY_ADDRESS,
  recipientAddress: BENEFICIARY_ADDRESS,
  beneficiaryPubKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  contractVersion: 'legacy-placeholder',
  redeemScriptHex: '51',
  activationFeePaid: true,
  activationFeeTxid: 'a'.repeat(64),
  activationFeeVerificationStatus: 'pending_verification',
  activation: {
    feeSats: '80000000',
    feeTxid: 'a'.repeat(64),
    feePaidAt: new Date().toISOString(),
    payerAddress: CONTRIBUTOR_ADDRESS,
    wcOfferId: null,
  },
  payout: {
    wcOfferId: null,
    txid: null,
    paidAt: null,
  },
};

let app: ReturnType<typeof createApp>;
const previousSqlitePath = process.env.TEYOLIA_SQLITE_PATH;
const previousDualWrite = process.env.CAMPAIGNS_DUAL_WRITE_JSON;
const previousPublicRefunds = process.env.ENABLE_PUBLIC_REFUNDS;

beforeAll(async () => {
  process.env.TEYOLIA_SQLITE_PATH = makeTestDbPath();
  process.env.CAMPAIGNS_DUAL_WRITE_JSON = 'false';
  delete process.env.ENABLE_PUBLIC_REFUNDS;

  const db = await openDatabase();
  await initializeDatabase(db);
  await upsertCampaign(LEGACY_RECORD, db);
  syncCampaignStoreFromDiskCampaigns([LEGACY_RECORD]);
  app = createApp();
});

afterAll(() => {
  restoreEnv('TEYOLIA_SQLITE_PATH', previousSqlitePath);
  restoreEnv('CAMPAIGNS_DUAL_WRITE_JSON', previousDualWrite);
  restoreEnv('ENABLE_PUBLIC_REFUNDS', previousPublicRefunds);
});

describe('legacy-placeholder security freeze', () => {
  it('rejects new legacy-placeholder campaign creation with the explicit code', async () => {
    const response = await request(app)
      .post('/api/campaigns')
      .send({
        id: 'campaign-new-legacy-placeholder',
        name: 'Must be rejected',
        goal: '1000',
        expirationTime: String(Date.now() + 86_400_000),
        contractVersion: ' legacy-placeholder ',
      });

    expectDisabled(response);
    expect(await getCampaignById('campaign-new-legacy-placeholder')).toBeNull();
  });

  it('keeps historical campaign reads available without exposing the redeem script', async () => {
    const detail = await request(app).get(`/api/campaigns/${LEGACY_CAMPAIGN_ID}`);

    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(LEGACY_CAMPAIGN_ID);
    expect(detail.body.contractVersion).toBe('legacy-placeholder');
    expect(detail.body.redeemScriptHex).toBeNull();
    expect(detail.body.covenant?.redeemScriptHex).toBeNull();

    const list = await request(app).get('/api/campaigns');
    const listed = list.body.find((campaign: { id?: string }) => campaign.id === LEGACY_CAMPAIGN_ID);
    expect(list.status).toBe(200);
    expect(listed).toMatchObject({
      id: LEGACY_CAMPAIGN_ID,
      contractVersion: 'legacy-placeholder',
      redeemScriptHex: null,
    });

    const summary = await request(app).get(`/api/campaigns/${LEGACY_CAMPAIGN_ID}/summary`);
    const pledges = await request(app).get(`/api/campaigns/${LEGACY_CAMPAIGN_ID}/pledges`);
    const history = await request(app).get(`/api/campaigns/${LEGACY_CAMPAIGN_ID}/history`);
    expect(summary.status).toBe(200);
    expect(summary.body.redeemScriptHex).toBeNull();
    expect(pledges.status).toBe(200);
    expect(pledges.body.pledges).toEqual([]);
    expect(history.status).toBe(200);
    expect(history.body).toEqual([]);

    const stored = await getCampaignById(LEGACY_CAMPAIGN_ID);
    expect(stored).not.toBeNull();
    expect(stored?.contractVersion).toBe('legacy-placeholder');
    expect(stored?.redeemScriptHex).toBe('51');
  });

  it('keeps activation status read-only and does not verify the legacy fee', async () => {
    const getTransactionInfo = vi.spyOn(ecashClient, 'getTransactionInfo');
    const addressToScriptPubKey = vi.spyOn(ecashClient, 'addressToScriptPubKey');
    const response = await request(app)
      .get(`/api/campaigns/${LEGACY_CAMPAIGN_ID}/activation/status`);

    expect(response.status).toBe(200);
    expect(response.body.contractVersion).toBe('legacy-placeholder');
    expect(response.body.activationFeeVerificationStatus).toBe('pending_verification');
    expect(response.body.redeemScriptHex).toBeNull();
    expect(getTransactionInfo).not.toHaveBeenCalled();
    expect(addressToScriptPubKey).not.toHaveBeenCalled();
  });

  it('rejects activation, activation offer creation, and activation verification', async () => {
    const responses = await Promise.all([
      request(app).post(`/api/campaigns/${LEGACY_CAMPAIGN_ID}/activate`).send({}),
      request(app).post(`/api/campaigns/${LEGACY_CAMPAIGN_ID}/activation/build`).send({}),
      request(app).post(`/api/campaigns/${LEGACY_CAMPAIGN_ID}/activation/confirm`).send({}),
    ]);

    responses.forEach(expectDisabled);
  });

  it('rejects pledge offer creation, transaction building, and pledge registration', async () => {
    const responses = await Promise.all([
      request(app).post(`/api/campaigns/${LEGACY_CAMPAIGN_ID}/pledge`).send({}),
      request(app).post(`/api/campaigns/${LEGACY_CAMPAIGN_ID}/pledge/build`).send({}),
      request(app).post(`/api/campaigns/${LEGACY_CAMPAIGN_ID}/pledge/confirm`).send({}),
    ]);

    responses.forEach(expectDisabled);
  });

  it('rejects finalize, payout build, payout confirmation, and the legacy payout alias', async () => {
    const responses = await Promise.all([
      request(app).post(`/api/campaign/${LEGACY_CAMPAIGN_ID}/finalize`).send({}),
      request(app).post(`/api/campaigns/${LEGACY_CAMPAIGN_ID}/finalize-request`).send({}),
      request(app).post(`/api/campaigns/${LEGACY_CAMPAIGN_ID}/payout/build`).send({}),
      request(app).post(`/api/campaigns/${LEGACY_CAMPAIGN_ID}/payout/confirm`).send({}),
      request(app).post(`/api/campaigns/${LEGACY_CAMPAIGN_ID}/payout`).send({}),
    ]);

    responses.forEach(expectDisabled);
  });

  it('rejects the public refund path for legacy-placeholder when public refunds are enabled', async () => {
    const previous = process.env.ENABLE_PUBLIC_REFUNDS;
    process.env.ENABLE_PUBLIC_REFUNDS = 'true';

    try {
      const response = await request(app)
        .post(`/api/campaign/${LEGACY_CAMPAIGN_ID}/refund`)
        .send({ pledgeId: 'historical-pledge' });

      expectDisabled(response);
    } finally {
      restoreEnv('ENABLE_PUBLIC_REFUNDS', previous);
    }
  });

  it('does not resolve a previously-created WalletConnect monetary offer', async () => {
    const offer = walletConnectOfferStore.createOffer({
      campaignId: LEGACY_CAMPAIGN_ID,
      mode: 'intent',
      outputs: [{ address: CONTRIBUTOR_ADDRESS, valueSats: 546 }],
      amount: '546',
      contributorAddress: CONTRIBUTOR_ADDRESS,
      userPrompt: 'Historical offer that must remain unusable',
    });

    const response = await request(app).get(`/api/walletconnect/offers/${offer.offerId}`);
    expectDisabled(response);
  });

  it('blocks direct campaign monetary state mutators', async () => {
    const service = new CampaignService();
    const calls: Array<() => Promise<unknown>> = [
      () => service.ensureCampaignCovenant(LEGACY_CAMPAIGN_ID),
      () => service.setActivationOffer(LEGACY_CAMPAIGN_ID, 'offer', CONTRIBUTOR_ADDRESS),
      () => service.recordActivationFeeBroadcast(LEGACY_CAMPAIGN_ID, 'b'.repeat(64)),
      () => service.finalizeActivationFeeVerification(LEGACY_CAMPAIGN_ID, 'b'.repeat(64), 'verified'),
      () => service.markActivationFeePaid(LEGACY_CAMPAIGN_ID, 'b'.repeat(64)),
      () => service.setPayoutOffer(LEGACY_CAMPAIGN_ID, 'payout-offer'),
      () => service.markPayoutComplete(LEGACY_CAMPAIGN_ID, 'c'.repeat(64), null),
      () => service.updateCampaignStatus(LEGACY_CAMPAIGN_ID, 'funded'),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toThrow(LEGACY_PLACEHOLDER_DISABLED_CODE);
    }
  });

  it('blocks builders, verification, refunds, finalize, and autopayout before monetary dependencies run', async () => {
    const legacyCampaign = await new CampaignService().getCampaign(LEGACY_CAMPAIGN_ID);
    expect(legacyCampaign?.contractVersion).toBe('legacy-placeholder');

    const getUtxosForAddress = vi.fn();
    const buildPledgeTx = vi.fn();
    const buildFinalizeTx = vi.fn();
    const buildPayoutTx = vi.fn();
    const buildRefundTx = vi.fn();
    const broadcastRawTx = vi.fn();
    const legacyFinalizeCampaign = vi.fn();
    const markPayoutComplete = vi.fn();
    const getTransactionInfo = vi.fn();
    const addressToScriptPubKey = vi.fn();
    const getPledgeByTxid = vi.fn();

    const pledgeService = new PledgeService({
      campaignService: { getCampaign: vi.fn().mockResolvedValue(legacyCampaign) },
      getUtxosForAddress,
      buildPledgeTx,
    });
    const pledgeVerificationService = new PledgeVerificationService({
      campaignService: { getCampaign: vi.fn().mockResolvedValue(legacyCampaign) },
      getTransactionInfo,
      addressToScriptPubKey,
      getPledgeByTxid,
    });
    const finalizeService = new FinalizeService({
      campaignService: {
        getCampaign: vi.fn().mockResolvedValue(legacyCampaign),
        markPayoutComplete,
      },
      getUtxosForAddress,
      buildFinalizeTx,
      broadcastRawTx,
      legacyFinalizeCampaign,
    });
    const autoPayoutService = new AutoPayoutService({
      campaignService: {
        getCampaign: vi.fn().mockResolvedValue(legacyCampaign),
        markPayoutComplete,
      },
      getUtxosForAddress,
      buildPayoutTx,
      broadcastRawTx,
      derivePrivKeyFromSeed: vi.fn(),
      signHybridPayoutTx: vi.fn(),
    });
    const refundService = new RefundService({
      campaignService: { getCampaign: vi.fn().mockResolvedValue(legacyCampaign) },
      getUtxosForAddress,
      buildRefundTx,
      broadcastRawTx,
      reconcilePendingPledgesForCampaign: vi.fn(),
    });

    const operations: Array<() => Promise<unknown>> = [
      () => pledgeService.createPledgeTx(LEGACY_CAMPAIGN_ID, CONTRIBUTOR_ADDRESS, 546n),
      () => pledgeVerificationService.verifyPledgeTx({
        campaignId: LEGACY_CAMPAIGN_ID,
        pledgeId: 'historical-pledge',
        txid: 'd'.repeat(64),
        expectedAmountSats: 546n,
      }),
      () => finalizeService.finalizeCampaign(LEGACY_CAMPAIGN_ID),
      () => finalizeService.createFinalizeTx(LEGACY_CAMPAIGN_ID),
      () => autoPayoutService.finalizeCampaign(LEGACY_CAMPAIGN_ID),
      () => refundService.refundCampaign({
        campaignId: LEGACY_CAMPAIGN_ID,
        pledgeId: 'historical-pledge',
      }),
      () => refundService.createRefundTx(LEGACY_CAMPAIGN_ID, CONTRIBUTOR_ADDRESS, 546n),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toThrow(LEGACY_PLACEHOLDER_DISABLED_CODE);
    }

    expect(getUtxosForAddress).not.toHaveBeenCalled();
    expect(buildPledgeTx).not.toHaveBeenCalled();
    expect(buildFinalizeTx).not.toHaveBeenCalled();
    expect(buildPayoutTx).not.toHaveBeenCalled();
    expect(buildRefundTx).not.toHaveBeenCalled();
    expect(broadcastRawTx).not.toHaveBeenCalled();
    expect(legacyFinalizeCampaign).not.toHaveBeenCalled();
    expect(markPayoutComplete).not.toHaveBeenCalled();
    expect(getTransactionInfo).not.toHaveBeenCalled();
    expect(addressToScriptPubKey).not.toHaveBeenCalled();
    expect(getPledgeByTxid).not.toHaveBeenCalled();
  });
});

function expectDisabled(response: { status: number; body: Record<string, unknown> }): void {
  expect(response.status).toBe(LEGACY_PLACEHOLDER_DISABLED_STATUS);
  expect(response.body).toMatchObject({
    error: LEGACY_PLACEHOLDER_DISABLED_CODE,
    code: LEGACY_PLACEHOLDER_DISABLED_CODE,
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
