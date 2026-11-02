// P7A-07 — gates fail-closed de broadcast y finalize (decisión t147s733, DEC-P7A07-1..9).
// Con ENABLE_PUBLIC_BROADCAST / ENABLE_CAMPAIGN_FINALIZE distintos de 'true' exacto, las 6 rutas responden
// 403 con su cuerpo exacto Y además: no hay broadcast (broadcastTx, broadcastRawTx, rpcCall, fetch), no se
// construye ni se firma nada (buildFinalizeTx, buildPayoutTx, signHybridPayoutTx), no se leen llaves
// (resolvePrivateKeyFromEnv, derivePrivKeyFromSeed ni lecturas directas de *PRIVKEY*/*SEED*/FORCE_RESCUE*
// en process.env), no se consulta la campaña y no se llama a FinalizeService ni a AutoPayoutService.
// Todo con fakes (vi.doMock / spies): sin red, sin Chronik real, sin llaves reales, sin firma.
// Los controles con el flag ON prueban que los espías están en el camino real de producción.
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDbPath } from './helpers/testDbPath';

const CAMPAIGN_ID = 'campaign-p7a07-1';
const CAMPAIGN_SCRIPT = '76a914' + '22'.repeat(20) + '88ac';
const ADDRESS = 'ecash:qpjm4qgv50v5vc6dpf6nu0w0epp8tzdn7gt0e06ssk';
const BENEFICIARY_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const FAKE_TXID = 'f'.repeat(64);
const FAKE_FINALIZE_HEX = 'p7a07-fake-finalize-hex';
const SENSITIVE_ENV = /PRIVKEY|SEED|FORCE_RESCUE|MNEMONIC|WIF/;

const BROADCAST_ROUTES = ['/api/broadcast', '/api/tx/broadcast'];
const FINALIZE_ROUTES = [
  `/api/campaign/${CAMPAIGN_ID}/finalize`,
  `/api/campaigns/${CAMPAIGN_ID}/finalize-request`,
  `/api/campaign/${CAMPAIGN_ID}/finalize-request`,
  `/api/campaigns/${CAMPAIGN_ID}/payout/build`,
];
const INVALID_ID_FINALIZE_ROUTES = [
  '/api/campaign/%20/finalize',
  '/api/campaigns/..%2F..%2Fetc/finalize-request',
  '/api/campaign/x%00y/finalize-request',
  '/api/campaigns/%20/payout/build',
];
const BROADCAST_BODY = { error: 'public-broadcast-disabled', code: 'public-broadcast-disabled' };
const FINALIZE_BODY = { error: 'campaign-finalize-disabled', code: 'campaign-finalize-disabled' };

// Todo valor distinto de 'true' exacto deja la ruta APAGADA (DEC-P7A07-3).
const DISABLED_VALUES: Array<string | undefined> = [
  undefined, '', 'false', 'FALSE', '0', 'no', 'off', ' false ', '1', 'yes', 'TRUE', 'True', ' true ', 'true ',
];
const BODIES: Array<Record<string, unknown>> = [
  {},
  { rawTxHex: '00'.repeat(10) },
  { rawTxHex: 'zz' },
  { beneficiaryAddress: ADDRESS },
  { pledgeId: 'pledge-p7a07', rawTxHex: '00'.repeat(10), txid: FAKE_TXID },
];
const FLAGS = ['ENABLE_PUBLIC_BROADCAST', 'ENABLE_CAMPAIGN_FINALIZE', 'ENABLE_PUBLIC_REFUNDS'] as const;
const ENV_KEYS = [...FLAGS, 'TEYOLIA_SQLITE_PATH', 'CAMPAIGNS_DUAL_WRITE_JSON', 'FORCE_RESCUE_CAMPAIGN_ID'];

type Spies = Record<
  | 'broadcastTx' | 'broadcastRawTx' | 'rpcCall' | 'fetch' | 'getUtxosForAddress'
  | 'buildFinalizeTx' | 'buildPayoutTx' | 'signHybridPayoutTx' | 'derivePrivKeyFromSeed'
  | 'resolvePrivateKeyFromEnv' | 'isV1Campaign' | 'selectCampaignCovenantUtxo',
  ReturnType<typeof vi.fn>
>;

function fakeCampaign() {
  return {
    id: CAMPAIGN_ID,
    name: 'P7A-07 fake',
    goal: '5000',
    status: 'active',
    contractVersion: 'teyolia-covenant-v1',
    beneficiaryAddress: ADDRESS,
    recipientAddress: ADDRESS,
    beneficiaryPubKey: BENEFICIARY_PUBKEY,
    campaignAddress: ADDRESS,
    escrowAddress: ADDRESS,
    scriptPubKey: CAMPAIGN_SCRIPT,
    redeemScriptHex: '51',
    activationFeePaid: true,
    payout: { wcOfferId: null, txid: null, paidAt: null },
  };
}

function installFakes(): Spies {
  const spies: Spies = {
    broadcastTx: vi.fn().mockResolvedValue({ txid: FAKE_TXID }),
    broadcastRawTx: vi.fn().mockResolvedValue({ txid: FAKE_TXID }),
    rpcCall: vi.fn().mockRejectedValue(new Error('p7a07: rpcCall no permitido')),
    fetch: vi.fn().mockRejectedValue(new Error('p7a07: red no permitida')),
    getUtxosForAddress: vi.fn().mockResolvedValue([]),
    buildFinalizeTx: vi.fn().mockResolvedValue({ unsignedTx: { inputs: [], outputs: [], locktime: 0 }, rawHex: FAKE_FINALIZE_HEX }),
    buildPayoutTx: vi.fn().mockRejectedValue(new Error('p7a07: buildPayoutTx no permitido')),
    signHybridPayoutTx: vi.fn().mockReturnValue('p7a07-fake-signed-hex'),
    derivePrivKeyFromSeed: vi.fn().mockReturnValue(Buffer.alloc(32, 9)),
    // Llave FICTICIA (bytes fijos): nunca se lee una llave real.
    resolvePrivateKeyFromEnv: vi.fn().mockResolvedValue(Buffer.alloc(32, 7)),
    isV1Campaign: vi.fn().mockReturnValue(true),
    selectCampaignCovenantUtxo: vi.fn().mockReturnValue({ txid: 'c'.repeat(64), vout: 0, value: 10_000n, scriptPubKey: CAMPAIGN_SCRIPT }),
  };
  vi.doMock('../blockchain/ecashClient', () => ({
    getEffectiveChronikBaseUrl: vi.fn(() => 'http://p7a07.invalid'),
    getUtxosForAddress: spies.getUtxosForAddress,
    getUtxosForScript: vi.fn().mockResolvedValue([]),
    getTipHeight: vi.fn().mockResolvedValue(0),
    broadcastTx: spies.broadcastTx,
    broadcastRawTx: spies.broadcastRawTx,
    getTransactionOutputs: vi.fn().mockResolvedValue([]),
    getTransactionInfo: vi.fn().mockRejectedValue(new Error('p7a07: sin Chronik')),
    getChronikBlockchainInfo: vi.fn().mockRejectedValue(new Error('p7a07: sin Chronik')),
    getBlockchainInfo: vi.fn().mockRejectedValue(new Error('p7a07: sin Chronik')),
    rpcCall: spies.rpcCall,
    addressToScriptPubKey: vi.fn().mockResolvedValue(CAMPAIGN_SCRIPT),
  }));
  vi.doMock('../blockchain/txBuilder', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../blockchain/txBuilder')>()),
    buildFinalizeTx: spies.buildFinalizeTx,
    buildPayoutTx: spies.buildPayoutTx,
    signHybridPayoutTx: spies.signHybridPayoutTx,
    derivePrivKeyFromSeed: spies.derivePrivKeyFromSeed,
  }));
  vi.doMock('../services/covenantV1Integration', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/covenantV1Integration')>()),
    isV1Campaign: spies.isV1Campaign,
    isV2GCampaign: vi.fn().mockReturnValue(false),
    resolveCampaignBeneficiaryAddress: vi.fn().mockReturnValue(ADDRESS),
    resolveCampaignEscrowAddress: vi.fn().mockReturnValue(ADDRESS),
    requireV1BeneficiaryPubKey: vi.fn().mockReturnValue(BENEFICIARY_PUBKEY),
    requireV1RedeemScriptHex: vi.fn().mockReturnValue('51'),
    filterSpendableUtxos: vi.fn((utxos: unknown[]) => utxos),
    selectCampaignCovenantUtxo: spies.selectCampaignCovenantUtxo,
    resolvePrivateKeyFromEnv: spies.resolvePrivateKeyFromEnv,
  }));
  vi.doMock('../services/PledgeReconciliationService', () => ({
    reconcilePendingPledgesForCampaign: vi.fn().mockResolvedValue({ inspected: 0, updated: 0, confirmed: 0, invalid: 0 }),
  }));
  vi.stubGlobal('fetch', spies.fetch);
  return spies;
}

async function loadApp() {
  const { CampaignService } = await import('../services/CampaignService');
  const { FinalizeService } = await import('../services/FinalizeService');
  const { AutoPayoutService } = await import('../services/AutoPayoutService');
  const service = {
    getCampaign: vi.spyOn(CampaignService.prototype, 'getCampaign').mockResolvedValue(fakeCampaign() as never),
    listCampaigns: vi.spyOn(CampaignService.prototype, 'listCampaigns').mockResolvedValue([] as never),
    markPayoutComplete: vi.spyOn(CampaignService.prototype, 'markPayoutComplete').mockResolvedValue(undefined as never),
    // call-through: si se llamara con el flag apagado, la aserción negativa lo detecta.
    finalize: vi.spyOn(FinalizeService.prototype, 'finalizeCampaign'),
    autoPayout: vi.spyOn(AutoPayoutService.prototype, 'finalizeCampaign').mockResolvedValue({
      status: 'paid_out', campaignId: CAMPAIGN_ID, goalSats: 5000n, raisedSats: 10_000n, txid: FAKE_TXID,
    } as never),
  };
  const { createApp } = await import('../app');
  return { app: createApp(), service };
}

type Loaded = Awaited<ReturnType<typeof loadApp>>;

// Registra las lecturas de nombres sensibles en process.env mientras se ejecutan las peticiones.
async function withEnvReadTracking<T>(fn: () => Promise<T>): Promise<{ result: T; reads: string[] }> {
  const realEnv = process.env;
  const reads: string[] = [];
  process.env = new Proxy(realEnv, {
    get(target, key, receiver) {
      if (typeof key === 'string' && SENSITIVE_ENV.test(key)) reads.push(key);
      return Reflect.get(target, key, receiver);
    },
  });
  try {
    return { result: await fn(), reads };
  } finally {
    process.env = realEnv;
  }
}

function expectNothingMonetary(spies: Spies, loaded: Loaded, reads: string[]) {
  expect(spies.broadcastTx).not.toHaveBeenCalled();
  expect(spies.broadcastRawTx).not.toHaveBeenCalled();
  expect(spies.rpcCall).not.toHaveBeenCalled();
  expect(spies.fetch).not.toHaveBeenCalled();
  expect(spies.buildFinalizeTx).not.toHaveBeenCalled();
  expect(spies.buildPayoutTx).not.toHaveBeenCalled();
  expect(spies.signHybridPayoutTx).not.toHaveBeenCalled();
  expect(spies.derivePrivKeyFromSeed).not.toHaveBeenCalled();
  expect(spies.resolvePrivateKeyFromEnv).not.toHaveBeenCalled();
  expect(spies.getUtxosForAddress).not.toHaveBeenCalled();
  expect(loaded.service.finalize).not.toHaveBeenCalled();
  expect(loaded.service.autoPayout).not.toHaveBeenCalled();
  expect(loaded.service.getCampaign).not.toHaveBeenCalled();
  expect(loaded.service.markPayoutComplete).not.toHaveBeenCalled();
  expect(reads).toEqual([]);
}

function setFlag(name: (typeof FLAGS)[number], value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('P7A-07: broadcast y finalize apagados por defecto, sin broadcast, firma ni lectura de llaves', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    for (const flag of FLAGS) delete process.env[flag];
    delete process.env.FORCE_RESCUE_CAMPAIGN_ID;
    process.env.TEYOLIA_SQLITE_PATH = makeTestDbPath();
    process.env.CAMPAIGNS_DUAL_WRITE_JSON = 'false';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock('../blockchain/ecashClient');
    vi.doUnmock('../blockchain/txBuilder');
    vi.doUnmock('../services/covenantV1Integration');
    vi.doUnmock('../services/PledgeReconciliationService');
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  for (const value of DISABLED_VALUES) {
    const label = value === undefined ? '(ausente)' : JSON.stringify(value);
    it(`ENABLE_PUBLIC_BROADCAST=${label}: 403 exacto en las 2 rutas, sin broadcast`, async () => {
      setFlag('ENABLE_PUBLIC_BROADCAST', value);
      const spies = installFakes();
      const loaded = await loadApp();
      const { reads } = await withEnvReadTracking(async () => {
        for (const route of BROADCAST_ROUTES) {
          for (const body of BODIES) {
            const res = await request(loaded.app).post(route).send(body);
            expect(res.status, `${route} ${JSON.stringify(body)}`).toBe(403);
            expect(res.body).toEqual(BROADCAST_BODY);
          }
        }
      });
      expectNothingMonetary(spies, loaded, reads);
    });

    it(`ENABLE_CAMPAIGN_FINALIZE=${label}: 403 exacto en las 4 rutas, sin firma, llaves ni broadcast`, async () => {
      setFlag('ENABLE_CAMPAIGN_FINALIZE', value);
      // FORCE_RESCUE apuntando a la campaña no debe saltar el gate.
      process.env.FORCE_RESCUE_CAMPAIGN_ID = CAMPAIGN_ID;
      const spies = installFakes();
      const loaded = await loadApp();
      const { reads } = await withEnvReadTracking(async () => {
        for (const route of [...FINALIZE_ROUTES, ...INVALID_ID_FINALIZE_ROUTES]) {
          for (const body of BODIES) {
            const res = await request(loaded.app).post(route).send(body);
            expect(res.status, `${route} ${JSON.stringify(body)}`).toBe(403);
            expect(res.body).toEqual(FINALIZE_BODY);
          }
        }
      });
      expectNothingMonetary(spies, loaded, reads);
    });
  }

  it('handleBroadcast exportado (llamada directa) también respeta el gate', async () => {
    const spies = installFakes();
    const { handleBroadcast } = await import('../routes/broadcast.routes');
    const res = { statusCode: 200, body: undefined as unknown,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: unknown) { this.body = payload; return this; } };
    await handleBroadcast({ body: { rawTxHex: '00'.repeat(10) } }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual(BROADCAST_BODY);
    expect(spies.broadcastTx).not.toHaveBeenCalled();
  });

  it('familias independientes: un flag no abre la otra familia ni los refunds', async () => {
    const spies = installFakes();
    const loaded = await loadApp();
    setFlag('ENABLE_PUBLIC_BROADCAST', 'true');
    for (const route of FINALIZE_ROUTES) {
      const res = await request(loaded.app).post(route).send({});
      expect(res.status).toBe(403);
      expect(res.body).toEqual(FINALIZE_BODY);
    }
    setFlag('ENABLE_PUBLIC_BROADCAST', undefined);
    setFlag('ENABLE_CAMPAIGN_FINALIZE', 'true');
    setFlag('ENABLE_PUBLIC_REFUNDS', 'true');
    for (const route of BROADCAST_ROUTES) {
      const res = await request(loaded.app).post(route).send({ rawTxHex: '00'.repeat(10) });
      expect(res.status).toBe(403);
      expect(res.body).toEqual(BROADCAST_BODY);
    }
    setFlag('ENABLE_CAMPAIGN_FINALIZE', undefined);
    setFlag('ENABLE_PUBLIC_REFUNDS', undefined);
    setFlag('ENABLE_PUBLIC_BROADCAST', 'true');
    process.env.ENABLE_CAMPAIGN_FINALIZE = 'true';
    const refund = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/refund`).send({ pledgeId: 'p' });
    expect(refund.status).toBe(403);
    expect(refund.body).toEqual({ error: 'public-refunds-disabled', code: 'public-refunds-disabled' });
    expect(spies.broadcastTx).not.toHaveBeenCalled();
    expect(spies.broadcastRawTx).not.toHaveBeenCalled();
    expect(spies.resolvePrivateKeyFromEnv).not.toHaveBeenCalled();
    expect(loaded.service.finalize).not.toHaveBeenCalled();
  });

  it('rutas no gateadas conservan su comportamiento con ambos flags apagados (sin router.use global)', async () => {
    installFakes();
    const loaded = await loadApp();
    const list = await request(loaded.app).get('/api/campaigns');
    expect(list.status).toBe(200);
    const offer = await request(loaded.app).get('/api/walletconnect/offers/p7a07-missing');
    const confirm = await request(loaded.app).post(`/api/campaigns/${CAMPAIGN_ID}/payout/confirm`).send({});
    const unknown = await request(loaded.app).post('/api/p7a07-no-such-route').send({});
    for (const res of [offer, confirm, unknown]) {
      expect(res.status).not.toBe(403);
      expect(res.body?.code).not.toBe(BROADCAST_BODY.code);
      expect(res.body?.code).not.toBe(FINALIZE_BODY.code);
      expect(res.body?.error).not.toBe(BROADCAST_BODY.error);
      expect(res.body?.error).not.toBe(FINALIZE_BODY.error);
    }
    expect(unknown.status).toBe(404);
    const health = await request(loaded.app).get('/health');
    expect(health.status).toBe(200);
  });

  it('control de cableado broadcast (flag ON, fakes): las 2 rutas llegan al broadcastTx falso', async () => {
    setFlag('ENABLE_PUBLIC_BROADCAST', 'true');
    const spies = installFakes();
    const loaded = await loadApp();
    for (const route of BROADCAST_ROUTES) {
      const res = await request(loaded.app).post(route).send({ rawTxHex: 'AB'.repeat(10) });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ txid: FAKE_TXID, message: 'broadcasted' });
    }
    expect(spies.broadcastTx).toHaveBeenCalledTimes(2);
    expect(spies.fetch).not.toHaveBeenCalled();
    expect(spies.rpcCall).not.toHaveBeenCalled();
  });

  it('control de cableado finalize V1 (flag ON, fakes): las 4 rutas leen la llave (falsa), firman (falso) y transmiten (falso)', async () => {
    setFlag('ENABLE_CAMPAIGN_FINALIZE', 'true');
    const spies = installFakes();
    const loaded = await loadApp();
    const { reads } = await withEnvReadTracking(async () => {
      for (const route of FINALIZE_ROUTES) {
        const res = await request(loaded.app).post(route).send({});
        expect(res.status, route).toBe(200);
        expect(res.body.txid).toBe(FAKE_TXID);
      }
    });
    expect(loaded.service.finalize).toHaveBeenCalledTimes(4);
    expect(loaded.service.getCampaign).toHaveBeenCalled();
    expect(spies.resolvePrivateKeyFromEnv).toHaveBeenCalledTimes(4);
    expect(spies.buildFinalizeTx).toHaveBeenCalledTimes(4);
    expect(spies.broadcastRawTx).toHaveBeenCalledTimes(4);
    expect(spies.broadcastRawTx).toHaveBeenCalledWith(FAKE_FINALIZE_HEX);
    // El detector de lecturas está conectado: el camino real lee los nombres de gas wallet y FORCE_RESCUE.
    expect(reads).toEqual(expect.arrayContaining(['FORCE_RESCUE_CAMPAIGN_ID', 'GAS_WALLET_SEED', 'GAS_WALLET_PRIVKEY']));
    expect(spies.fetch).not.toHaveBeenCalled();
    expect(spies.rpcCall).not.toHaveBeenCalled();
  });

  it('control de cableado finalize legacy (flag ON, fakes): llega a AutoPayoutService (falso)', async () => {
    setFlag('ENABLE_CAMPAIGN_FINALIZE', 'true');
    const spies = installFakes();
    spies.isV1Campaign.mockReturnValue(false);
    const loaded = await loadApp();
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(200);
    expect(loaded.service.autoPayout).toHaveBeenCalledTimes(1);
    expect(spies.fetch).not.toHaveBeenCalled();
  });
});
