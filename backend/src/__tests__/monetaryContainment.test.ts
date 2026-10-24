import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import {
  MONETARY_FLOWS_DISABLED_CODE,
  MONETARY_FLOWS_DISABLED_STATUS,
  UNSUPPORTED_MONETARY_CONTRACT_VERSION_CODE,
  monetaryFlowsEnabled,
} from '../security/monetaryContractPolicy';
import {
  LEGACY_PLACEHOLDER_DISABLED_CODE,
  assertLegacyPlaceholderMonetaryOperationsAllowed,
} from '../security/legacyPlaceholderFreeze';
import {
  CampaignService,
  syncCampaignStoreFromDiskCampaigns,
} from '../services/CampaignService';
import { PledgeService } from '../services/PledgeService';
import {
  getCampaignById,
  initializeDatabase,
  openDatabase,
  upsertCampaign,
  type StoredCampaign,
} from '../db/SQLiteStore';
import { makeTestDbPath } from './helpers/testDbPath';
import { TEYOLIA_COVENANT_V1 } from '../covenants/scriptCompiler';

const BENEFICIARY_PUBKEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const REFUND_ORACLE_PUBKEY =
  '036360e856310ce5d294e8be33fc807077dc56ac80d95d9cd4ddbd21325eff73f7';
const CAMPAIGN_ADDRESS = 'ecash:pqx87w2wp47gcq2mx7nargg08vy74czg0sqdxccpss';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = {
    ...originalEnv,
    TEYOLIA_MONETARY_FLOWS_ENABLED: 'true',
    CAMPAIGNS_DUAL_WRITE_JSON: 'false',
    TEYOLIA_BENEFICIARY_PUBKEY: BENEFICIARY_PUBKEY,
    TEYOLIA_REFUND_ORACLE_PUBKEY: REFUND_ORACLE_PUBKEY,
  };
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe('fail-closed monetary containment', () => {
  it('parses the monetary kill-switch strictly', () => {
    delete process.env.TEYOLIA_MONETARY_FLOWS_ENABLED;
    expect(monetaryFlowsEnabled()).toBe(false);

    process.env.TEYOLIA_MONETARY_FLOWS_ENABLED = ' true ';
    expect(monetaryFlowsEnabled()).toBe(true);

    for (const invalid of ['', '1', 'yes', 'TRUEE', 'enabled']) {
      process.env.TEYOLIA_MONETARY_FLOWS_ENABLED = invalid;
      expect(monetaryFlowsEnabled()).toBe(false);
    }
  });

  it('blocks monetary HTTP routes, broadcast, and stale WalletConnect offer resolution', async () => {
    process.env.TEYOLIA_MONETARY_FLOWS_ENABLED = 'false';
    const app = createApp();

    const health = await request(app).get('/health');
    expect(health.status).toBe(200);

    const blocked = await Promise.all([
      request(app).post('/api/campaigns/campaign-safe/pledge').send({}),
      request(app).post('/api/campaigns/campaign-safe/activation/build').send({}),
      request(app).post('/api/campaigns/campaign-safe/finalize-request').send({}),
      request(app).post('/api/campaign/campaign-safe/refund').send({ pledgeId: 'pledge-1' }),
      request(app).post('/api/broadcast').send({ rawTxHex: '00' }),
      request(app).post('/api/broadcast/').send({ rawTxHex: '00' }),
      request(app).post('/api/tx/broadcast/').send({ rawTxHex: '00' }),
      request(app).post('/API/BROADCAST').send({ rawTxHex: '00' }),
      request(app).get('/api/walletconnect/offers/stale-offer'),
    ]);

    for (const response of blocked) {
      expect(response.status).toBe(MONETARY_FLOWS_DISABLED_STATUS);
      expect(response.body).toEqual({
        error: MONETARY_FLOWS_DISABLED_CODE,
        code: MONETARY_FLOWS_DISABLED_CODE,
      });
    }
  });

  it('keeps unsafe payout aliases permanently closed independently of the kill-switch', async () => {
    process.env.TEYOLIA_MONETARY_FLOWS_ENABLED = 'true';
    const app = createApp();

    const payoutVariants = [
      '/api/campaigns/campaign-safe/payout',
      '/api/campaigns/campaign-safe/payout/',
      '/API/CAMPAIGNS/campaign-safe/PAYOUT',
      '/api/campaign/campaign-safe/payout/',
    ];
    for (const path of payoutVariants) {
      const response = await request(app).post(path).send({});
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('legacy-payout-route-disabled');
    }

    const confirmVariants = [
      '/api/campaigns/campaign-safe/payout/confirm',
      '/api/campaigns/campaign-safe/payout/confirm/',
      '/API/CAMPAIGNS/campaign-safe/PAYOUT/CONFIRM',
    ];
    for (const path of confirmVariants) {
      const response = await request(app)
        .post(path)
        .send({ txid: 'a'.repeat(64) });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('unverified-payout-confirm-disabled');
    }
  });

  it('fails in the service layer before blockchain spend dependencies are invoked', async () => {
    process.env.TEYOLIA_MONETARY_FLOWS_ENABLED = 'false';

    const getUtxosForAddress = vi.fn();
    const buildPledgeTx = vi.fn();
    const service = new PledgeService({
      campaignService: {
        getCampaign: vi.fn().mockResolvedValue({
          id: 'campaign-service-gate',
          campaignAddress: CAMPAIGN_ADDRESS,
          covenantAddress: CAMPAIGN_ADDRESS,
          contractVersion: TEYOLIA_COVENANT_V1,
          redeemScriptHex: '51',
        }),
      },
      getUtxosForAddress,
      buildPledgeTx,
    });

    await expect(
      service.createPledgeTx(
        'campaign-service-gate',
        'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
        1000n,
      ),
    ).rejects.toThrow(MONETARY_FLOWS_DISABLED_CODE);

    expect(getUtxosForAddress).not.toHaveBeenCalled();
    expect(buildPledgeTx).not.toHaveBeenCalled();
  });

  it('never upgrades an unversioned historical snapshot during hydrate/get/list', async () => {
    const dbPath = makeTestDbPath();
    process.env.TEYOLIA_SQLITE_PATH = dbPath;

    const db = await openDatabase(dbPath);
    await initializeDatabase(db);

    const campaignId = 'campaign-unversioned-read-only';
    const historical: StoredCampaign = {
      id: campaignId,
      name: 'Historical unversioned campaign',
      description: 'Must remain read-only',
      goal: '1000',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: new Date().toISOString(),
      status: 'active',
      beneficiaryAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
      campaignAddress: CAMPAIGN_ADDRESS,
      covenantAddress: CAMPAIGN_ADDRESS,
      beneficiaryPubKey: BENEFICIARY_PUBKEY,
      refundOraclePubKey: REFUND_ORACLE_PUBKEY,
      contractVersion: undefined,
      redeemScriptHex: '51',
      scriptHash: '11'.repeat(20),
      scriptPubKey: `a914${'22'.repeat(20)}87`,
      activationFeePaid: true,
      activationFeeVerificationStatus: 'verified',
      payout: {
        wcOfferId: null,
        txid: null,
        paidAt: null,
      },
    };

    await upsertCampaign(historical, db);
    syncCampaignStoreFromDiskCampaigns([historical]);

    const service = new CampaignService();
    const detail = await service.getCampaign(campaignId);
    const list = await service.listCampaigns();
    const listed = list.find((campaign) => campaign.id === campaignId);
    const stored = await getCampaignById(campaignId, db);

    expect(detail?.contractVersion).toBeNull();
    expect(detail?.redeemScriptHex).toBeNull();
    expect(listed?.contractVersion).toBeNull();
    expect(listed?.redeemScriptHex).toBeNull();

    expect(stored?.contractVersion).toBeUndefined();
    expect(stored?.redeemScriptHex).toBe('51');
    expect(stored?.campaignAddress).toBe(CAMPAIGN_ADDRESS);
  });

  it('treats whitespace-padded historical contract versions as unsupported and never upgrades them', async () => {
    const dbPath = makeTestDbPath();
    process.env.TEYOLIA_SQLITE_PATH = dbPath;

    const db = await openDatabase(dbPath);
    await initializeDatabase(db);

    const campaignId = 'campaign-malformed-version-read-only';
    const historical: StoredCampaign = {
      id: campaignId,
      name: 'Malformed historical version',
      description: 'Whitespace-padded version must remain unsupported',
      goal: '1000',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: new Date().toISOString(),
      status: 'active',
      beneficiaryAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
      campaignAddress: CAMPAIGN_ADDRESS,
      covenantAddress: CAMPAIGN_ADDRESS,
      beneficiaryPubKey: BENEFICIARY_PUBKEY,
      refundOraclePubKey: REFUND_ORACLE_PUBKEY,
      contractVersion: ` ${TEYOLIA_COVENANT_V1} `,
      redeemScriptHex: '51',
      scriptHash: '33'.repeat(20),
      scriptPubKey: `a914${'44'.repeat(20)}87`,
      activationFeePaid: true,
      activationFeeVerificationStatus: 'verified',
      payout: {
        wcOfferId: null,
        txid: null,
        paidAt: null,
      },
    };

    await upsertCampaign(historical, db);
    syncCampaignStoreFromDiskCampaigns([historical]);

    const service = new CampaignService();
    const detail = await service.getCampaign(campaignId);
    const stored = await getCampaignById(campaignId, db);

    expect(detail?.contractVersion).toBeNull();
    expect(detail?.redeemScriptHex).toBeNull();
    expect(stored?.contractVersion).toBe(` ${TEYOLIA_COVENANT_V1} `);
    expect(stored?.redeemScriptHex).toBe('51');
  });

  it('distinguishes exact legacy from unsupported unknown versions when monetary flows are enabled', () => {
    process.env.TEYOLIA_MONETARY_FLOWS_ENABLED = 'true';

    expect(() =>
      assertLegacyPlaceholderMonetaryOperationsAllowed({
        contractVersion: 'legacy-placeholder',
      }),
    ).toThrow(LEGACY_PLACEHOLDER_DISABLED_CODE);

    expect(() =>
      assertLegacyPlaceholderMonetaryOperationsAllowed({
        contractVersion: 'future-unknown-version',
      }),
    ).toThrow(UNSUPPORTED_MONETARY_CONTRACT_VERSION_CODE);
  });
});
