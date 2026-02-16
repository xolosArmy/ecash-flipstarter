import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CampaignService } from '../services/CampaignService';
import { makeTestDbPath } from './helpers/testDbPath';

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

beforeAll(() => {
  process.env.TEYOLIA_SQLITE_PATH = makeTestDbPath();
});

afterAll(() => {
  delete process.env.TEYOLIA_SQLITE_PATH;
});

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.E_CASH_BACKEND;
  delete process.env.CHRONIK_URL;
});

describe('activation fee rules', () => {
  it('does not allow ACTIVE status before activation fee is paid', async () => {
    const service = new CampaignService();
    const campaignId = uniqueId('activation-unpaid');

    await service.createCampaign({
      id: campaignId,
      name: 'Needs fee',
      goal: 1000n,
      expirationTime: BigInt(Date.now() + 7 * 24 * 60 * 60 * 1000),
      beneficiaryAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
    });

    await expect(service.updateCampaignStatus(campaignId, 'active')).rejects.toThrow('activation-fee-unpaid');

    const summary = await service.getCampaign(campaignId);
    expect(summary?.status).toBe('pending_fee');
    expect(summary?.activationFeePaid).toBe(false);
  });

  it('marks campaign active after activation fee confirmation', async () => {
    const service = new CampaignService();
    const campaignId = uniqueId('activation-paid');

    await service.createCampaign({
      id: campaignId,
      name: 'Fee paid campaign',
      goal: 1000n,
      expirationTime: BigInt(Date.now() + 7 * 24 * 60 * 60 * 1000),
      beneficiaryAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
    });

    await service.markActivationFeePaid(campaignId, 'a'.repeat(64), {
      paidAt: new Date().toISOString(),
      payerAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
    });

    const summary = await service.getCampaign(campaignId);
    expect(summary?.status).toBe('active');
    expect(summary?.activationFeePaid).toBe(true);
    expect(summary?.activationFeeTxid).toBe('a'.repeat(64));

    const history = await service.getCampaignHistory(campaignId);
    const paidEvents = history.filter((entry) => entry.event === 'ACTIVATION_FEE_PAID');
    expect(paidEvents).toHaveLength(1);
  });

  it('is idempotent when confirming the same activation txid twice', async () => {
    const service = new CampaignService();
    const campaignId = uniqueId('activation-idempotent');

    await service.createCampaign({
      id: campaignId,
      name: 'Idempotent activation',
      goal: 1000n,
      expirationTime: BigInt(Date.now() + 7 * 24 * 60 * 60 * 1000),
      beneficiaryAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
    });

    const txid = 'b'.repeat(64);
    await service.markActivationFeePaid(campaignId, txid, {
      paidAt: new Date().toISOString(),
      payerAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
    });
    await service.markActivationFeePaid(campaignId, txid, {
      paidAt: new Date().toISOString(),
      payerAddress: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
    });

    const summary = await service.getCampaign(campaignId);
    expect(summary?.status).toBe('active');
    expect(summary?.activationFeePaid).toBe(true);
    expect(summary?.activationFeeTxid).toBe(txid);

    const history = await service.getCampaignHistory(campaignId);
    const paidEvents = history.filter((entry) => entry.event === 'ACTIVATION_FEE_PAID');
    expect(paidEvents).toHaveLength(1);
  });

  it('does not duplicate ACTIVATION_FEE_VERIFIED audit logs for same txid', async () => {
    const service = new CampaignService();
    const campaignId = uniqueId('activation-verified-idempotent');

    await service.createCampaign({
      id: campaignId,
      name: 'Verified idempotent activation',
      goal: 1000n,
      expirationTime: BigInt(Date.now() + 7 * 24 * 60 * 60 * 1000),
      beneficiaryAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
    });

    const txid = 'c'.repeat(64);
    await service.recordActivationFeeBroadcast(campaignId, txid);
    await service.finalizeActivationFeeVerification(campaignId, txid, 'verified');
    await service.finalizeActivationFeeVerification(campaignId, txid, 'verified');

    const summary = await service.getCampaign(campaignId);
    expect(summary?.status).toBe('active');
    expect(summary?.activationFeePaid).toBe(true);
    expect(summary?.activationFeeVerificationStatus).toBe('verified');

    const history = await service.getCampaignHistory(campaignId);
    const verifiedEvents = history.filter((entry) => entry.event === 'ACTIVATION_FEE_VERIFIED');
    expect(verifiedEvents).toHaveLength(1);
  });

  it('does not duplicate ACTIVATION_FEE_OFFER_CREATED when reusing persisted intent', async () => {
    const service = new CampaignService();
    const campaignId = uniqueId('activation-offer-idempotent');

    await service.createCampaign({
      id: campaignId,
      name: 'Offer reuse activation',
      goal: 1000n,
      expirationTime: BigInt(Date.now() + 7 * 24 * 60 * 60 * 1000),
      beneficiaryAddress: 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk',
    });

    await service.setActivationOffer(campaignId, 'offer-1', 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk', {
      mode: 'intent',
      outputs: [{ address: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk', valueSats: 80000000 }],
      treasuryAddressUsed: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
    });
    await service.setActivationOffer(campaignId, 'offer-1', 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk', {
      mode: 'intent',
      outputs: [{ address: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk', valueSats: 80000000 }],
      treasuryAddressUsed: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
      logAuditEvent: false,
    });

    const history = await service.getCampaignHistory(campaignId);
    const offerEvents = history.filter((entry) => entry.event === 'ACTIVATION_FEE_OFFER_CREATED');
    expect(offerEvents).toHaveLength(1);
  });
});

describe('ecashClient chronik protobuf wrapper', () => {
  it('maps confirmed chronik tx to transaction info with confirmations >= 1', async () => {
    process.env.E_CASH_BACKEND = 'chronik';
    process.env.CHRONIK_URL = 'https://chronik.xolosarmy.xyz';
    const txMock = vi.fn().mockResolvedValue({
      outputs: [{ sats: 80000000n, outputScript: '76a914abcd88ac' }],
      block: { height: 900000 },
    });
    const blockchainInfoMock = vi.fn().mockResolvedValue({ tipHeight: 900100 });
    vi.doMock('chronik-client', () => ({
      ChronikClient: vi.fn().mockImplementation(() => ({
        tx: txMock,
        blockchainInfo: blockchainInfoMock,
      })),
    }));

    const ecashClient = await import('../blockchain/ecashClient');
    const info = await ecashClient.getTransactionInfo('a'.repeat(64));
    const blockchainInfo = await ecashClient.getBlockchainInfo();

    expect(info.txid).toBe('a'.repeat(64));
    expect(info.confirmations).toBe(1);
    expect(info.height).toBe(900000);
    expect(info.outputs).toEqual([{ scriptPubKey: '76a914abcd88ac', valueSats: 80000000n }]);
    expect(blockchainInfo).toEqual({ tipHeight: 900100 });
  });

  it('maps unconfirmed chronik tx as pending (confirmations = 0)', async () => {
    process.env.E_CASH_BACKEND = 'chronik';
    process.env.CHRONIK_URL = 'https://chronik.xolosarmy.xyz';
    const txMock = vi.fn().mockResolvedValue({
      outputs: [{ sats: 2000n, outputScript: '76a914ffff88ac' }],
    });
    vi.doMock('chronik-client', () => ({
      ChronikClient: vi.fn().mockImplementation(() => ({
        tx: txMock,
      })),
    }));

    const ecashClient = await import('../blockchain/ecashClient');
    const info = await ecashClient.getTransactionInfo('b'.repeat(64));

    expect(info.txid).toBe('b'.repeat(64));
    expect(info.confirmations).toBe(0);
    expect(info.height).toBe(-1);
    expect(info.outputs).toEqual([{ scriptPubKey: '76a914ffff88ac', valueSats: 2000n }]);
  });

  it('preserves outputs needed to detect invalid treasury output/monto insuficiente', async () => {
    process.env.E_CASH_BACKEND = 'chronik';
    process.env.CHRONIK_URL = 'https://chronik.xolosarmy.xyz';
    const txMock = vi.fn().mockResolvedValue({
      outputs: [{ sats: 1000n, outputScript: '76a914not-treasury88ac' }],
      block: { height: 910000 },
    });
    vi.doMock('chronik-client', () => ({
      ChronikClient: vi.fn().mockImplementation(() => ({
        tx: txMock,
      })),
    }));

    const ecashClient = await import('../blockchain/ecashClient');
    const info = await ecashClient.getTransactionInfo('c'.repeat(64));

    expect(info.confirmations).toBe(1);
    expect(info.outputs).toEqual([{ scriptPubKey: '76a914not-treasury88ac', valueSats: 1000n }]);
  });

  it('returns clear error with chronik url and txid when chronik is down', async () => {
    process.env.E_CASH_BACKEND = 'chronik';
    process.env.CHRONIK_URL = 'https://chronik.xolosarmy.xyz';
    const txMock = vi.fn().mockRejectedValue(new Error('timeout'));
    vi.doMock('chronik-client', () => ({
      ChronikClient: vi.fn().mockImplementation(() => ({
        tx: txMock,
      })),
    }));

    const ecashClient = await import('../blockchain/ecashClient');
    await expect(ecashClient.getTransactionInfo('d'.repeat(64))).rejects.toThrow(
      /chronik tx d{64} failed for https:\/\/chronik\.xolosarmy\.xyz: timeout/,
    );
  });
});
