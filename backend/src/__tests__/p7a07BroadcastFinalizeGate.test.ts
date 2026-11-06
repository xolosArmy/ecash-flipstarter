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
import http from 'node:http';
import { makeTestDbPath } from './helpers/testDbPath';
import {
  installDeniedNetwork,
  expectNetworkDeniedUnused,
  flushAsyncWork,
  resolveNetTarget,
  isAllowedLocalTarget,
  clearDeniedNetworkSpies,
  type DeniedNetworkSpies,
} from './helpers/denyNetwork';

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
> & { net: DeniedNetworkSpies };

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
  const spies = {
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
  // P8G-06: niega http|https|net (MA8-17).
  const net = installDeniedNetwork();
  return { ...spies, net };
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
  expectNetworkDeniedUnused(spies.net);
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

  afterEach(async () => {
    await flushAsyncWork(); // P7A-04: vaciar trabajo diferido antes de asertar/limpiar
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








  it('P8G-06 H12a: hostname heredado en prototipo de options NO overridea URL externa', async () => {
    // Dictamen Auditor dd5795a H12: `in` veía hostname loopback heredado; Node lo ignora.
    const opts = Object.assign(Object.create({ hostname: '127.0.0.1' }), {
      port: 80,
      method: 'POST' as const,
    });
    expect(resolveNetTarget(['http://198.51.100.1/', opts], 'http')).toEqual({
      kind: 'host',
      host: '198.51.100.1',
    });
    expect(isAllowedLocalTarget(resolveNetTarget(['http://198.51.100.1/', opts], 'http'))).toBe(false);
    // URL object
    expect(resolveNetTarget([new URL('http://198.51.100.1/'), opts], 'http')).toEqual({
      kind: 'host',
      host: '198.51.100.1',
    });

    const spies = installFakes();
    const loaded = await loadApp();
    expect(() => {
      (spies.net.httpRequest as any)('http://198.51.100.1/', opts);
    }).toThrow(/p8a: http\.request denegado.*198\.51\.100\.1/);
    expect(() => {
      (spies.net.httpsRequest as any)(new URL('https://198.51.100.1/'), Object.assign(Object.create({ hostname: '127.0.0.1' }), { port: 443, method: 'POST' }));
    }).toThrow(/p8a: https\.request denegado.*198\.51\.100\.1/);
    expect(() => {
      (spies.net.httpGet as any)(new URL('http://198.51.100.1/'), Object.assign(Object.create({ hostname: '127.0.0.1' }), { port: 80 }));
    }).toThrow(/p8a: http\.get denegado.*198\.51\.100\.1/);

    clearDeniedNetworkSpies(spies.net);
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(403);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });

  it('P8G-06 H12b: hostname propio no enumerable NO overridea URL externa', async () => {
    // Dictamen: hasOwn solo no basta — Node solo copia enumerables.
    const opts: Record<string, unknown> = { port: 80, method: 'POST' };
    Object.defineProperty(opts, 'hostname', {
      value: '127.0.0.1',
      enumerable: false,
      configurable: true,
      writable: true,
    });
    expect(resolveNetTarget(['http://198.51.100.1/', opts], 'http')).toEqual({
      kind: 'host',
      host: '198.51.100.1',
    });
    expect(isAllowedLocalTarget(resolveNetTarget(['http://198.51.100.1/', opts], 'http'))).toBe(false);

    const spies = installFakes();
    const loaded = await loadApp();
    expect(() => {
      (spies.net.httpRequest as any)('http://198.51.100.1/', opts);
    }).toThrow(/p8a: http\.request denegado.*198\.51\.100\.1/);
    expect(() => {
      (spies.net.httpsGet as any)(new URL('https://198.51.100.1/'), opts);
    }).toThrow(/p8a: https\.get denegado.*198\.51\.100\.1/);

    clearDeniedNetworkSpies(spies.net);
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(403);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });

  it('P8G-06 H11: URL+options con hostname:undefined limpia URL y usa host externo', async () => {
    // Dictamen Auditor f4314dc H11: `'hostname' in options` con undefined conservaba loopback de la URL.
    const opts = { hostname: undefined as unknown as string, host: '198.51.100.1', port: 80, method: 'POST' as const };
    expect(resolveNetTarget(['http://127.0.0.1/', opts], 'http')).toEqual({
      kind: 'host',
      host: '198.51.100.1',
    });
    expect(isAllowedLocalTarget(resolveNetTarget(['http://127.0.0.1/', opts], 'http'))).toBe(false);
    // URL object + misma options
    expect(resolveNetTarget([new URL('http://127.0.0.1/'), opts], 'http')).toEqual({
      kind: 'host',
      host: '198.51.100.1',
    });
    // https.get misma semántica in-operator
    expect(
      resolveNetTarget([new URL('https://127.0.0.1/'), { hostname: undefined, host: '198.51.100.1', port: 443 }], 'http'),
    ).toEqual({ kind: 'host', host: '198.51.100.1' });

    const spies = installFakes();
    const loaded = await loadApp();
    expect(() => {
      (spies.net.httpRequest as any)('http://127.0.0.1/', opts);
    }).toThrow(/p8a: http\.request denegado.*198\.51\.100\.1/);
    expect(() => {
      (spies.net.httpsRequest as any)(new URL('https://127.0.0.1/'), {
        hostname: undefined,
        host: '198.51.100.1',
        port: 443,
        method: 'POST',
      });
    }).toThrow(/p8a: https\.request denegado.*198\.51\.100\.1/);
    expect(() => {
      (spies.net.httpGet as any)(new URL('http://127.0.0.1/'), {
        hostname: undefined,
        host: '198.51.100.1',
        port: 80,
      });
    }).toThrow(/p8a: http\.get denegado.*198\.51\.100\.1/);

    clearDeniedNetworkSpies(spies.net);
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(403);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });

  it('P8G-06 H9: http.request(new URL(loopback), {hostname: externo}) destino efectivo remoto', async () => {
    // Dictamen Auditor 27a705d H9: URL object no se fusionaba con options (solo string).
    const url = new URL('http://127.0.0.1/');
    const opts = { hostname: '198.51.100.1', port: 80, method: 'POST' as const };
    expect(resolveNetTarget([url, opts], 'http')).toEqual({ kind: 'host', host: '198.51.100.1' });
    expect(isAllowedLocalTarget(resolveNetTarget([url, opts], 'http'))).toBe(false);
    // URL object solo (sin override) sigue loopback
    expect(isAllowedLocalTarget(resolveNetTarget([url], 'http'))).toBe(true);
    // https.get / http.get con URL object + options
    expect(resolveNetTarget([new URL('https://127.0.0.1/'), { hostname: '198.51.100.1', port: 443 }], 'http')).toEqual({
      kind: 'host',
      host: '198.51.100.1',
    });

    const spies = installFakes();
    const loaded = await loadApp();
    expect(() => {
      (spies.net.httpRequest as any)(url, opts);
    }).toThrow(/p8a: http\.request denegado.*198\.51\.100\.1/);
    expect(() => {
      (spies.net.httpsRequest as any)(new URL('https://127.0.0.1/'), {
        hostname: '198.51.100.1',
        port: 443,
        method: 'POST',
      });
    }).toThrow(/p8a: https\.request denegado.*198\.51\.100\.1/);
    expect(() => {
      (spies.net.httpGet as any)(new URL('http://127.0.0.1/'), { hostname: '198.51.100.1', port: 80 });
    }).toThrow(/p8a: http\.get denegado.*198\.51\.100\.1/);

    clearDeniedNetworkSpies(spies.net);
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(403);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });

  it('P8G-06 H10: net.connect({host: externo, hostname: loopback}) usa host (semántica net)', async () => {
    // Dictamen Auditor 27a705d H10: resolver HTTP (hostname-first) se aplicaba a net.
    const opts = { host: '198.51.100.1', hostname: '127.0.0.1', port: 443 };
    expect(resolveNetTarget([opts], 'net')).toEqual({ kind: 'host', host: '198.51.100.1' });
    expect(isAllowedLocalTarget(resolveNetTarget([opts], 'net'))).toBe(false);
    // Contraste: misma options bajo semántica HTTP verían hostname loopback
    expect(resolveNetTarget([opts], 'http')).toEqual({ kind: 'host', host: '127.0.0.1' });
    expect(isAllowedLocalTarget(resolveNetTarget([opts], 'http'))).toBe(true);
    // createConnection misma regla
    expect(resolveNetTarget([{ host: '198.51.100.1', hostname: '127.0.0.1', port: 443 }], 'net')).toEqual({
      kind: 'host',
      host: '198.51.100.1',
    });

    const spies = installFakes();
    const loaded = await loadApp();
    expect(() => {
      (spies.net.netConnect as any)(opts);
    }).toThrow(/p8a: net\.connect denegado.*198\.51\.100\.1/);
    expect(() => {
      (spies.net.netCreateConnection as any)(opts);
    }).toThrow(/p8a: net\.createConnection denegado.*198\.51\.100\.1/);

    clearDeniedNetworkSpies(spies.net);
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(403);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });

  it('P8G-06 H7: http.get({hostname,port,path}) externo se deniega (API hermana de request)', async () => {
    // Dictamen Auditor 345ffaf H7: http.get no estaba stubbeado → 37/37 verdes.
    const opts = { hostname: '198.51.100.1', port: 80, path: '/' };
    expect(resolveNetTarget([opts])).toEqual({ kind: 'host', host: '198.51.100.1' });
    expect(isAllowedLocalTarget(resolveNetTarget([opts]))).toBe(false);

    const spies = installFakes();
    const loaded = await loadApp();
    expect(() => {
      (spies.net.httpGet as any)(opts);
    }).toThrow(/p8a: http\.get denegado.*198\.51\.100\.1/);
    expect(() => {
      (spies.net.httpsGet as any)({ hostname: '198.51.100.1', port: 443, path: '/' });
    }).toThrow(/p8a: https\.get denegado.*198\.51\.100\.1/);
    // También forma string URL
    expect(() => {
      (spies.net.httpGet as any)('http://198.51.100.1/');
    }).toThrow(/p8a: http\.get denegado.*198\.51\.100\.1/);

    clearDeniedNetworkSpies(spies.net);
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(403);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });

  it('P8G-06 H8: destino efectivo — URL loopback+options hostname externo; host loopback+hostname externo', async () => {
    // Dictamen Auditor 345ffaf H8: Node usa options sobre URL y prioriza hostname sobre host.
    const urlOpts: unknown[] = [
      'http://127.0.0.1/',
      { hostname: '198.51.100.1', port: 80, method: 'POST' },
    ];
    expect(resolveNetTarget(urlOpts)).toEqual({ kind: 'host', host: '198.51.100.1' });
    expect(isAllowedLocalTarget(resolveNetTarget(urlOpts))).toBe(false);

    const hostHostname = {
      host: '127.0.0.1',
      hostname: '198.51.100.1',
      port: 80,
      path: '/',
      method: 'POST',
    };
    expect(resolveNetTarget([hostHostname])).toEqual({ kind: 'host', host: '198.51.100.1' });
    expect(isAllowedLocalTarget(resolveNetTarget([hostHostname]))).toBe(false);

    // Control: solo host loopback sigue permitido
    expect(isAllowedLocalTarget(resolveNetTarget([{ host: '127.0.0.1', port: 80, path: '/' }]))).toBe(
      true,
    );
    // URL loopback sin options override → permitido
    expect(isAllowedLocalTarget(resolveNetTarget(['http://127.0.0.1/']))).toBe(true);

    const spies = installFakes();
    const loaded = await loadApp();
    expect(() => {
      (spies.net.httpRequest as any)(...urlOpts);
    }).toThrow(/p8a: http\.request denegado.*198\.51\.100\.1/);
    expect(() => {
      (spies.net.httpRequest as any)(hostHostname);
    }).toThrow(/p8a: http\.request denegado.*198\.51\.100\.1/);
    // https con misma forma de override también denegado
    expect(() => {
      (spies.net.httpsRequest as any)('https://127.0.0.1/', {
        hostname: '198.51.100.1',
        port: 443,
        method: 'POST',
      });
    }).toThrow(/p8a: https\.request denegado.*198\.51\.100\.1/);

    clearDeniedNetworkSpies(spies.net);
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(403);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });

  it('P8G-06 H6: http.request({hostname,port,path:"/"}) NO es IPC y se deniega', async () => {
    // Dictamen Auditor ff09d20 H6: path:"/" + hostname se clasificaba IPC y escapaba.
    const opts = { hostname: '198.51.100.1', port: 80, path: '/', method: 'POST' };
    expect(resolveNetTarget([opts])).toEqual({ kind: 'host', host: '198.51.100.1' });
    expect(isAllowedLocalTarget(resolveNetTarget([opts]))).toBe(false);
    expect(resolveNetTarget([{ host: '198.51.100.1', port: 443, path: '/x' }])).toEqual({
      kind: 'host',
      host: '198.51.100.1',
    });
    // IPC real sin host sigue permitido
    expect(resolveNetTarget([{ path: '/var/run/teyolia.sock' }])).toEqual({ kind: 'ipc' });
    expect(isAllowedLocalTarget(resolveNetTarget([{ path: '/var/run/teyolia.sock' }]))).toBe(true);

    const spies = installFakes();
    const loaded = await loadApp();
    expect(() => {
      (spies.net.httpRequest as any)(opts);
    }).toThrow(/p8a: http\.request denegado.*198\.51\.100\.1/);
    expect(() => {
      (spies.net.httpsRequest as any)({ hostname: '198.51.100.1', port: 443, path: '/', method: 'POST' });
    }).toThrow(/p8a: https\.request denegado.*198\.51\.100\.1/);

    clearDeniedNetworkSpies(spies.net);
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(403);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });

  it('P8G-06 H1: net.connect(port, host) externo se deniega y cuenta (overload posicional)', async () => {
    // Dictamen Auditor b8dd400 H1: connect(443, '198.51.100.1') evadía el stub.
    expect(resolveNetTarget([443, '198.51.100.1'])).toEqual({ kind: 'host', host: '198.51.100.1' });
    expect(isAllowedLocalTarget(resolveNetTarget([443, '198.51.100.1']))).toBe(false);
    expect(resolveNetTarget([443])).toEqual({ kind: 'loopback-implicit' });
    expect(isAllowedLocalTarget(resolveNetTarget([443]))).toBe(true);
    expect(resolveNetTarget([{ port: 443, host: '198.51.100.1' }], 'net')).toEqual({
      kind: 'host',
      host: '198.51.100.1',
    });

    const spies = installFakes();
    const loaded = await loadApp();
    expect(() => {
      (spies.net.netConnect as any)(443, '198.51.100.1');
    }).toThrow(/p8a: net\.connect denegado.*198\.51\.100\.1/);
    expect(() => {
      (spies.net.netCreateConnection as any)(443, '198.51.100.1');
    }).toThrow(/p8a: net\.createConnection denegado.*198\.51\.100\.1/);

    // Tras disparos directos, limpiar y comprobar que finalize/broadcast apagados no usan net remoto.
    clearDeniedNetworkSpies(spies.net);
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(403);
    expect(res.body).toEqual(FINALIZE_BODY);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });

  it('P8G-06 E-A: https.request externo se registra y falla el test; loopback http sigue para supertest', async () => {
    const spies = installFakes();
    const loaded = await loadApp();
    // Disparo directo sobre el stub (misma referencia que vería un import de https en producción).
    expect(() => { (spies.net.httpsRequest as any)('https://chronik.p7a07.invalid/broadcast-tx'); }).toThrow(
      /p8a: https\.request denegado/,
    );
    expect(() => { (spies.net.httpRequest as any)('http://evil.example/x'); }).toThrow(/p8a: http\.request denegado/);
    // Supertest (loopback) debe seguir funcionando con el stub instalado.
    const res = await request(loaded.app).post('/api/broadcast').send({ rawTxHex: '00' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual(BROADCAST_BODY);
    // Tras un 403 limpio no debe quedar https.request pendiente de la app.
    // (el disparo directo anterior sí contó: lo limpiamos para la aserción de rama apagada)
    clearDeniedNetworkSpies(spies.net);
    const res2 = await request(loaded.app).post('/api/tx/broadcast').send({ rawTxHex: '00' });
    expect(res2.status).toBe(403);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });


  it('P8G-06 H13: net host remoto heredado + hostname loopback propio → remoto (Node [[Get]])', async () => {
    // Dictamen Auditor d7d819b H13: ownEnumerable ignoraba host heredado; Node sí lo lee.
    const opts = Object.assign(Object.create({ host: '198.51.100.1' }), {
      hostname: '127.0.0.1',
      port: 443,
    });
    expect(resolveNetTarget([opts], 'net')).toEqual({ kind: 'host', host: '198.51.100.1' });
    expect(isAllowedLocalTarget(resolveNetTarget([opts], 'net'))).toBe(false);
    // Espejo createConnection
    expect(resolveNetTarget([Object.assign(Object.create({ host: '198.51.100.1' }), { hostname: '127.0.0.1', port: 443 })], 'net')).toEqual({
      kind: 'host',
      host: '198.51.100.1',
    });
    // Control cercano: host heredado loopback + hostname propio remoto → remoto (fail-closed)
    const localInherited = Object.assign(Object.create({ host: '127.0.0.1' }), {
      hostname: '198.51.100.1',
      port: 443,
    });
    // Conflicto host(loopback heredado) vs hostname(remoto propio): fail-closed UNTRUSTED (H14 familia /
    // denegación conservadora del dictamen SW-net-inherited-local DETECTADA).
    const localT = resolveNetTarget([localInherited], 'net');
    expect(localT.kind).toBe('host');
    expect(isAllowedLocalTarget(localT)).toBe(false);

    const spies = installFakes();
    const loaded = await loadApp();
    expect(() => {
      (spies.net.netConnect as any)(opts);
    }).toThrow(/p8a: net\.connect denegado.*198\.51\.100\.1/);
    expect(() => {
      (spies.net.netCreateConnection as any)(
        Object.assign(Object.create({ host: '198.51.100.1' }), { hostname: '127.0.0.1', port: 443 }),
      );
    }).toThrow(/p8a: net\.createConnection denegado.*198\.51\.100\.1/);

    clearDeniedNetworkSpies(spies.net);
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(403);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });

  it('P8G-06 H14a: getter hostname variable (4ª lectura remota) se deniega fail-closed', async () => {
    // Dictamen Auditor d7d819b H14: stub muestreaba temprano loopback; Node leía remoto en 4ª.
    const opts = (() => {
      let n = 0;
      return {
        port: 80,
        method: 'POST' as const,
        get hostname() {
          return ++n === 4 ? '198.51.100.1' : '127.0.0.1';
        },
      };
    })();
    const t = resolveNetTarget(['http://198.51.100.1/', opts], 'http');
    expect(t.kind).toBe('host');
    expect(isAllowedLocalTarget(t)).toBe(false);

    const spies = installFakes();
    const loaded = await loadApp();
    expect(() => {
      (spies.net.httpRequest as any)('http://198.51.100.1/', opts);
    }).toThrow(/p8a: http\.request denegado/);
    expect(() => {
      // Getter constante remoto sobre URL loopback — también denegado (accessor).
      (spies.net.httpRequest as any)('http://127.0.0.1/', {
        port: 80,
        get hostname() {
          return '198.51.100.1';
        },
      });
    }).toThrow(/p8a: http\.request denegado/);

    clearDeniedNetworkSpies(spies.net);
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(403);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });

  it('P8G-06 H14b: Proxy hostname variable se deniega fail-closed', async () => {
    const opts = (() => {
      let n = 0;
      return new Proxy(
        { hostname: '127.0.0.1', port: 80, method: 'POST' },
        {
          get(t, k, r) {
            if (k === 'hostname') return ++n === 4 ? '198.51.100.1' : '127.0.0.1';
            return Reflect.get(t, k, r);
          },
        },
      );
    })();
    const t = resolveNetTarget(['http://198.51.100.1/', opts], 'http');
    expect(t.kind).toBe('host');
    expect(isAllowedLocalTarget(t)).toBe(false);

    const spies = installFakes();
    const loaded = await loadApp();
    expect(() => {
      (spies.net.httpRequest as any)('http://198.51.100.1/', opts);
    }).toThrow(/p8a: http\.request denegado/);
    expect(() => {
      (spies.net.httpsRequest as any)(
        'https://198.51.100.1/',
        new Proxy({ hostname: '127.0.0.1', port: 443 }, {
          get(t, k, r) {
            return k === 'hostname' ? '127.0.0.1' : Reflect.get(t, k, r);
          },
        }),
      );
    }).toThrow(/p8a: https\.request denegado/);

    clearDeniedNetworkSpies(spies.net);
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(403);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });


  it('P8G-06 H15: Proxy en prototipo cambia host en 5ª lectura → UNTRUSTED (net)', async () => {
    // Dictamen Auditor b1697e0 H15: 4 lecturas veían loopback; Node consumía remoto en 5ª.
    const opts = (() => {
      let n = 0;
      return Object.assign(
        Object.create(
          new Proxy(
            { host: '127.0.0.1' },
            {
              get(t, k, r) {
                if (k === 'host') return ++n === 5 ? '198.51.100.1' : '127.0.0.1';
                return Reflect.get(t, k, r);
              },
            },
          ),
        ),
        { port: 443 },
      );
    })();
    const resolved = resolveNetTarget([opts], 'net');
    expect(resolved.kind).toBe('host');
    expect(isAllowedLocalTarget(resolved)).toBe(false);

    const spies = installFakes();
    const loaded = await loadApp();
    expect(() => {
      (spies.net.netConnect as any)(opts);
    }).toThrow(/p8a: net\.connect denegado/);
    expect(() => {
      (spies.net.netCreateConnection as any)(
        (() => {
          let n = 0;
          return Object.assign(
            Object.create(
              new Proxy(
                { host: '127.0.0.1' },
                {
                  get(t, k, r) {
                    if (k === 'host') return ++n === 5 ? '198.51.100.1' : '127.0.0.1';
                    return Reflect.get(t, k, r);
                  },
                },
              ),
            ),
            { port: 443 },
          );
        })(),
      );
    }).toThrow(/p8a: net\.createConnection denegado/);

    clearDeniedNetworkSpies(spies.net);
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(403);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });

  it('P8G-06 H16: lookup custom localhost→IP remota se deniega (http y net)', async () => {
    // Dictamen Auditor b1697e0 H16: destino textual loopback; lookup resuelve remoto.
    const netOpts = {
      host: 'localhost',
      port: 443,
      lookup: ((_h: any, _o: any, cb: any) => cb(null, '198.51.100.1', 4)) as any,
    };
    const httpOpts = {
      hostname: 'localhost',
      port: 80,
      lookup: ((_h: any, _o: any, cb: any) => cb(null, '198.51.100.1', 4)) as any,
    };
    expect(isAllowedLocalTarget(resolveNetTarget([netOpts], 'net'))).toBe(false);
    expect(isAllowedLocalTarget(resolveNetTarget([httpOpts], 'http'))).toBe(false);

    const spies = installFakes();
    const loaded = await loadApp();
    expect(() => {
      (spies.net.netConnect as any)(netOpts);
    }).toThrow(/p8a: net\.connect denegado/);
    expect(() => {
      (spies.net.httpRequest as any)(httpOpts);
    }).toThrow(/p8a: http\.request denegado/);
    expect(() => {
      (spies.net.httpGet as any)({
        hostname: 'localhost',
        port: 80,
        lookup: ((_h: any, _o: any, cb: any) => cb(null, '198.51.100.1', 4)) as any,
      });
    }).toThrow(/p8a: http\.get denegado/);

    clearDeniedNetworkSpies(spies.net);
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(403);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });


  it('P8G-06 H17a: Agent.lookup custom localhost→IP remota se deniega (AUD-H17-agent-lookup)', async () => {
    // Dictamen Auditor efab7ee H17: hasUntrustedTransportHook no miraba options.agent.
    const opts = {
      hostname: 'localhost',
      port: 80,
      agent: new http.Agent({
        lookup: ((_h: any, _o: any, cb: any) => cb(null, '198.51.100.1', 4)) as any,
      }),
    };
    expect(isAllowedLocalTarget(resolveNetTarget([opts], 'http'))).toBe(false);

    const spies = installFakes();
    const loaded = await loadApp();
    expect(() => {
      (spies.net.httpRequest as any)(opts);
    }).toThrow(/p8a: http\.request denegado/);
    expect(() => {
      (spies.net.httpsRequest as any)({
        hostname: 'localhost',
        port: 443,
        agent: new http.Agent({
          lookup: ((_h: any, _o: any, cb: any) => cb(null, '198.51.100.1', 4)) as any,
        }),
      });
    }).toThrow(/p8a: https\.request denegado/);

    clearDeniedNetworkSpies(spies.net);
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(403);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });

  it('P8G-06 H17b: Agent.createConnection propio se deniega (AUD-H17-agent-createConnection)', async () => {
    const opts = {
      hostname: 'localhost',
      port: 80,
      agent: (() => {
        const a = new http.Agent();
        a.createConnection = ((o: any, cb: any) => {
          throw new Error('REMOTE_FACTORY_REACHED');
        }) as any;
        return a;
      })(),
    };
    expect(isAllowedLocalTarget(resolveNetTarget([opts], 'http'))).toBe(false);

    const spies = installFakes();
    const loaded = await loadApp();
    expect(() => {
      (spies.net.httpRequest as any)(opts);
    }).toThrow(/p8a: http\.request denegado/);
    expect(() => {
      (spies.net.httpGet as any)({
        hostname: 'localhost',
        port: 80,
        agent: (() => {
          const a = new http.Agent();
          a.createConnection = ((o: any, cb: any) => {
            throw new Error('REMOTE_FACTORY_REACHED');
          }) as any;
          return a;
        })(),
      });
    }).toThrow(/p8a: http\.get denegado/);

    clearDeniedNetworkSpies(spies.net);
    const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
    expect(res.status).toBe(403);
    expectNetworkDeniedUnused(spies.net);
    await flushAsyncWork();
  });


  it('P8G-06 H18a: globalAgent.lookup in-place sin options.agent → UNTRUSTED (AUD-H18c)', async () => {
    // Dictamen Auditor 1331c58 H18: Agent efectivo no se evaluaba si options.agent ausente.
    const prev = Object.getOwnPropertyDescriptor(http.globalAgent, 'lookup');
    try {
      (http.globalAgent as any).lookup = ((_h: any, _o: any, cb: any) =>
        cb(null, '198.51.100.1', 4)) as any;
      const opts = { hostname: 'localhost', port: 80 };
      expect(isAllowedLocalTarget(resolveNetTarget([opts], 'http'))).toBe(false);

      const spies = installFakes();
      const loaded = await loadApp();
      expect(() => {
        (spies.net.httpRequest as any)(opts);
      }).toThrow(/p8a: http\.request denegado/);
      clearDeniedNetworkSpies(spies.net);
      const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
      expect(res.status).toBe(403);
      expectNetworkDeniedUnused(spies.net);
      await flushAsyncWork();
    } finally {
      if (prev) Object.defineProperty(http.globalAgent, 'lookup', prev);
      else delete (http.globalAgent as any).lookup;
    }
  });

  it('P8G-06 H18b: globalAgent.createConnection in-place sin options.agent → UNTRUSTED (AUD-H18c)', async () => {
    const prev = Object.getOwnPropertyDescriptor(http.globalAgent, 'createConnection');
    try {
      (http.globalAgent as any).createConnection = ((o: any, cb: any) => {
        throw new Error('REMOTE_FACTORY_REACHED');
      }) as any;
      const opts = { hostname: 'localhost', port: 80 };
      expect(isAllowedLocalTarget(resolveNetTarget([opts], 'http'))).toBe(false);

      const spies = installFakes();
      const loaded = await loadApp();
      expect(() => {
        (spies.net.httpRequest as any)(opts);
      }).toThrow(/p8a: http\.request denegado/);
      clearDeniedNetworkSpies(spies.net);
      const res = await request(loaded.app).post(`/api/campaign/${CAMPAIGN_ID}/finalize`).send({});
      expect(res.status).toBe(403);
      expectNetworkDeniedUnused(spies.net);
      await flushAsyncWork();
    } finally {
      if (prev) Object.defineProperty(http.globalAgent, 'createConnection', prev);
      else delete (http.globalAgent as any).createConnection;
    }
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
