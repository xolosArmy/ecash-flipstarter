// PR-7 (a) — T-16 reforzado (reconciliación v2 §5; criterio 9 / GT-14; RQ-05).
// Con ENABLE_PUBLIC_REFUNDS ausente o falso, POST /api/campaign/:id/refund responde 403
// `public-refunds-disabled` Y, además, (1) RefundService.refundCampaign no se llama y (2) no hay
// broadcast: ninguna función de emisión de `blockchain/ecashClient` (broadcastRawTx, broadcastTx,
// rpcCall) ni `fetch` se invocan, y tampoco se construye ni se marca un reembolso.
// Todo con fakes inyectados por vi.doMock: sin red, sin Chronik real, sin llaves, sin firma.
// Los controles de cableado (flag ON) prueban que los espías están en el camino real de producción:
// sin ellos, un espía mal conectado haría pasar las aserciones negativas en falso.
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installDeniedNetwork,
  expectNetworkDeniedUnused,
  flushAsyncWork,
  clearDeniedNetworkSpies,
  type DeniedNetworkSpies,
} from './helpers/denyNetwork';

const CAMPAIGN_ID = 'campaign-t16-1';
const CAMPAIGN_SCRIPT = '76a914' + '22'.repeat(20) + '88ac';
const CAMPAIGN_ADDRESS = 'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
const CONTRIBUTOR_ADDRESS = 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59jrf5035';
const PLEDGE_ID = 'pledge-t16-1';
const FAKE_TXID = 'e'.repeat(64);

type Spies = {
  broadcastRawTx: ReturnType<typeof vi.fn>;
  broadcastTx: ReturnType<typeof vi.fn>;
  rpcCall: ReturnType<typeof vi.fn>;
  getUtxosForAddress: ReturnType<typeof vi.fn>;
  buildRefundTx: ReturnType<typeof vi.fn>;
  markPledgeRefunded: ReturnType<typeof vi.fn>;
  getPledgeById: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  net: DeniedNetworkSpies;
};

function installFakes(): Spies {
  const spies = {
    broadcastRawTx: vi.fn().mockResolvedValue({ txid: FAKE_TXID }),
    broadcastTx: vi.fn().mockResolvedValue({ txid: FAKE_TXID }),
    rpcCall: vi.fn().mockRejectedValue(new Error('t16: rpcCall no permitido')),
    getUtxosForAddress: vi.fn().mockResolvedValue([
      { txid: 'c'.repeat(64), vout: 0, value: 5000n, scriptPubKey: CAMPAIGN_SCRIPT },
    ]),
    buildRefundTx: vi.fn().mockResolvedValue({
      unsignedTx: {
        inputs: [{ txid: 'c'.repeat(64), vout: 0, value: 5000n, scriptPubKey: CAMPAIGN_SCRIPT }],
        outputs: [],
        locktime: 0,
      },
      rawHex: 't16-fake-refund-hex',
    }),
    markPledgeRefunded: vi.fn().mockResolvedValue({ pledgeId: PLEDGE_ID }),
    getPledgeById: vi.fn().mockResolvedValue({
      pledgeId: PLEDGE_ID,
      campaignId: CAMPAIGN_ID,
      amount: 1000,
      contributorAddress: CONTRIBUTOR_ADDRESS,
      status: 'confirmed',
    }),
    fetch: vi.fn().mockRejectedValue(new Error('t16: red no permitida')),
  };
  // Cliente de cadena falso: ninguna exportación habla con Chronik ni con RPC.
  vi.doMock('../blockchain/ecashClient', () => ({
    getEffectiveChronikBaseUrl: vi.fn(() => 'http://t16.invalid'),
    getUtxosForAddress: spies.getUtxosForAddress,
    getUtxosForScript: vi.fn().mockResolvedValue([]),
    getTipHeight: vi.fn().mockResolvedValue(0),
    broadcastTx: spies.broadcastTx,
    broadcastRawTx: spies.broadcastRawTx,
    getTransactionOutputs: vi.fn().mockResolvedValue([]),
    getTransactionInfo: vi.fn().mockRejectedValue(new Error('t16: sin Chronik')),
    getChronikBlockchainInfo: vi.fn().mockRejectedValue(new Error('t16: sin Chronik')),
    getBlockchainInfo: vi.fn().mockRejectedValue(new Error('t16: sin Chronik')),
    rpcCall: spies.rpcCall,
    addressToScriptPubKey: vi.fn().mockResolvedValue(CAMPAIGN_SCRIPT),
  }));
  vi.doMock('../blockchain/txBuilder', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../blockchain/txBuilder')>()),
    buildRefundTx: spies.buildRefundTx,
  }));
  vi.doMock('../store/simplePledges', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../store/simplePledges')>()),
    getPledgeById: spies.getPledgeById,
    getConfirmedTotalByCampaign: vi.fn().mockResolvedValue(1000),
    markPledgeRefunded: spies.markPledgeRefunded,
  }));
  vi.doMock('../services/CampaignService', () => ({
    CampaignService: vi.fn().mockImplementation(() => ({
      getCampaign: vi.fn().mockResolvedValue({
        id: CAMPAIGN_ID,
        goal: '5000',
        campaignAddress: CAMPAIGN_ADDRESS,
        scriptPubKey: CAMPAIGN_SCRIPT,
        expirationTime: String(Date.now() - 60_000),
        status: 'expired',
      }),
    })),
    campaignStore: new Map(),
    covenantIndexInstance: { getCovenantRef: vi.fn(), setCovenantRef: vi.fn(), updateValue: vi.fn() },
  }));
  vi.doMock('../services/PledgeReconciliationService', () => ({
    reconcilePendingPledgesForCampaign: vi.fn().mockResolvedValue({ inspected: 0, updated: 0, confirmed: 0, invalid: 0 }),
  }));
  vi.stubGlobal('fetch', spies.fetch);
  // P8G-06 / P7A-04: niega http|https|net.
  const net = installDeniedNetwork();
  return { ...spies, net };
}

async function loadRefundApp() {
  const { RefundService } = await import('../services/RefundService');
  // Espía sobre el método real (call-through): el router usa `new RefundService()` al cargarse.
  const refundSpy = vi.spyOn(RefundService.prototype, 'refundCampaign');
  const refundRouter = (await import('../routes/refund.routes')).default;
  const app = express();
  app.use(express.json());
  app.use('/api', refundRouter);
  return { app, refundSpy };
}

function expectNoRefundAndNoBroadcast(spies: Spies, refundSpy: unknown) {
  expect(refundSpy).not.toHaveBeenCalled();
  expect(spies.broadcastRawTx).not.toHaveBeenCalled();
  expect(spies.broadcastTx).not.toHaveBeenCalled();
  expect(spies.rpcCall).not.toHaveBeenCalled();
  expect(spies.fetch).not.toHaveBeenCalled();
  expect(spies.buildRefundTx).not.toHaveBeenCalled();
  expect(spies.getUtxosForAddress).not.toHaveBeenCalled();
  expect(spies.getPledgeById).not.toHaveBeenCalled();
  expect(spies.markPledgeRefunded).not.toHaveBeenCalled();

  expectNetworkDeniedUnused(spies.net);
}

const DISABLED_VALUES: Array<string | undefined> = [
  // parseBooleanEnv solo enciende con 1|true|yes (trim+lower). 'on' y basura deben seguir en 403 (P7A-04).
  undefined, '', 'false', 'FALSE', '0', 'no', 'off', ' false ', 'on', 'enabled', '2', 'TRUE!',
];
const BODIES: Array<Record<string, unknown>> = [
  { pledgeId: PLEDGE_ID },
  {},
  { pledgeId: PLEDGE_ID, refundAddress: CONTRIBUTOR_ADDRESS },
  { pledgeId: PLEDGE_ID, refundAmount: 1000 },
];

describe('T-16 reforzado: reembolsos públicos deshabilitados sin refundCampaign ni broadcast', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.ENABLE_PUBLIC_REFUNDS;
  });

  afterEach(async () => {
    await flushAsyncWork(); // P7A-04
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock('../blockchain/ecashClient');
    vi.doUnmock('../blockchain/txBuilder');
    vi.doUnmock('../store/simplePledges');
    vi.doUnmock('../services/CampaignService');
    vi.doUnmock('../services/PledgeReconciliationService');
    delete process.env.ENABLE_PUBLIC_REFUNDS;
  });

  for (const value of DISABLED_VALUES) {
    it(`ENABLE_PUBLIC_REFUNDS=${value === undefined ? '(ausente)' : JSON.stringify(value)}: 403 y ni refundCampaign ni broadcast`, async () => {
      if (value !== undefined) process.env.ENABLE_PUBLIC_REFUNDS = value;
      const spies = installFakes();
      const { app, refundSpy } = await loadRefundApp();
      for (const body of BODIES) {
        const res = await request(app).post(`/api/campaign/${CAMPAIGN_ID}/refund`).send(body);
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'public-refunds-disabled', code: 'public-refunds-disabled' });
      }
      expectNoRefundAndNoBroadcast(spies, refundSpy);
    });
  }

  it('app completa (createApp) con el flag ausente: 403 y ni refundCampaign ni broadcast', async () => {
    const spies = installFakes();
    const { RefundService } = await import('../services/RefundService');
    const refundSpy = vi.spyOn(RefundService.prototype, 'refundCampaign');
    const { createApp } = await import('../app');
    const app = createApp();
    const res = await request(app).post(`/api/campaign/${CAMPAIGN_ID}/refund`).send({ pledgeId: PLEDGE_ID });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'public-refunds-disabled', code: 'public-refunds-disabled' });
    expectNoRefundAndNoBroadcast(spies, refundSpy);
  });

  it('control de cableado (flag ON, todo falso): el camino real llama a refundCampaign y al broadcast falso una vez', async () => {
    process.env.ENABLE_PUBLIC_REFUNDS = 'true';
    const spies = installFakes();
    const { app, refundSpy } = await loadRefundApp();
    const res = await request(app).post(`/api/campaign/${CAMPAIGN_ID}/refund`).send({ pledgeId: PLEDGE_ID });
    expect(res.status).toBe(200);
    expect(res.body.txid).toBe(FAKE_TXID);
    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(refundSpy).toHaveBeenCalledWith({ campaignId: CAMPAIGN_ID, pledgeId: PLEDGE_ID });
    expect(spies.buildRefundTx).toHaveBeenCalledTimes(1);
    expect(spies.broadcastRawTx).toHaveBeenCalledTimes(1);
    expect(spies.broadcastRawTx).toHaveBeenCalledWith('t16-fake-refund-hex');
    expect(spies.markPledgeRefunded).toHaveBeenCalledTimes(1);
    // Ni siquiera en el control hay red: el broadcast es un fake.
    expect(spies.fetch).not.toHaveBeenCalled();
    expect(spies.rpcCall).not.toHaveBeenCalled();
  });


  it('P8G-06/P7A-04 E-A: https.request externo denegado; refund apagado no toca red nativa', async () => {
    const spies = installFakes();
    const { app, refundSpy } = await loadRefundApp();
    expect(() => { (spies.net.httpsRequest as any)('https://chronik.t16.invalid/x'); }).toThrow(
      /p8a: https\.request denegado/,
    );
    clearDeniedNetworkSpies(spies.net);
    const res = await request(app).post(`/api/campaign/${CAMPAIGN_ID}/refund`).send({ pledgeId: PLEDGE_ID });
    expect(res.status).toBe(403);
    expectNoRefundAndNoBroadcast(spies, refundSpy);
    await flushAsyncWork();
  });

  it('control de cableado en la app completa (flag ON): refundCampaign y el broadcast falso se observan', async () => {
    process.env.ENABLE_PUBLIC_REFUNDS = '1';
    const spies = installFakes();
    const { RefundService } = await import('../services/RefundService');
    const refundSpy = vi.spyOn(RefundService.prototype, 'refundCampaign');
    const { createApp } = await import('../app');
    const res = await request(createApp()).post(`/api/campaign/${CAMPAIGN_ID}/refund`).send({ pledgeId: PLEDGE_ID });
    expect(res.status).toBe(200);
    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(spies.broadcastRawTx).toHaveBeenCalledTimes(1);
    expect(spies.fetch).not.toHaveBeenCalled();
  });
});
