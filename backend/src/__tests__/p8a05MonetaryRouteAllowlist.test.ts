/**
 * P8G-05 (PR-8a): el stack Express no puede ganar una ruta mutante (POST/PUT/PATCH/DELETE)
 * sin actualizar esta allowlist. Atrapa falsos verdes por alias/ruta/método nuevos olvidados
 * (MA8-07/08/09/13/14). No implementa gates de payout (eso es PR-8b).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDbPath } from './helpers/testDbPath';
import {
  listMountedRoutes,
  mutatingRoutes,
  routeKey,
  type MountedRoute,
} from './helpers/expressRouteInventory';
import { installDeniedNetwork, expectNetworkDeniedUnused } from './helpers/denyNetwork';

/**
 * Allowlist canónica de rutas mutantes montadas por createApp() en 164e8b3 + PR-8a.
 * Si añades una ruta en producción, DEBES actualizar esta lista en el mismo PR (revisión forzada).
 */
const EXPECTED_MUTATING_ROUTES: MountedRoute[] = [
  { method: 'POST', path: '/api/broadcast' },
  { method: 'POST', path: '/api/campaign' },
  { method: 'POST', path: '/api/campaign/:id/activate' },
  { method: 'POST', path: '/api/campaign/:id/activation/build' },
  { method: 'POST', path: '/api/campaign/:id/activation/confirm' },
  { method: 'POST', path: '/api/campaign/:id/finalize' },
  { method: 'POST', path: '/api/campaign/:id/finalize-request' },
  { method: 'POST', path: '/api/campaign/:id/pay-activation-fee' },
  { method: 'POST', path: '/api/campaign/:id/payout' },
  { method: 'POST', path: '/api/campaign/:id/pledge' },
  { method: 'POST', path: '/api/campaign/:id/refund' },
  { method: 'POST', path: '/api/campaigns' },
  { method: 'POST', path: '/api/campaigns/:id/activate' },
  { method: 'POST', path: '/api/campaigns/:id/activation/build' },
  { method: 'POST', path: '/api/campaigns/:id/activation/confirm' },
  { method: 'POST', path: '/api/campaigns/:id/finalize-request' },
  { method: 'POST', path: '/api/campaigns/:id/pay-activation-fee' },
  { method: 'POST', path: '/api/campaigns/:id/payout' },
  { method: 'POST', path: '/api/campaigns/:id/payout/build' },
  { method: 'POST', path: '/api/campaigns/:id/payout/confirm' },
  { method: 'POST', path: '/api/campaigns/:id/pledge' },
  { method: 'POST', path: '/api/campaigns/:id/pledge/build' },
  { method: 'POST', path: '/api/campaigns/:id/pledge/confirm' },
  { method: 'POST', path: '/api/tx/broadcast' },
];

/** Familias ya gateadas (P7A-07 / T-16): deben existir en el inventario. */
const REQUIRED_GATED_MONETARY: MountedRoute[] = [
  { method: 'POST', path: '/api/broadcast' },
  { method: 'POST', path: '/api/tx/broadcast' },
  { method: 'POST', path: '/api/campaign/:id/finalize' },
  { method: 'POST', path: '/api/campaign/:id/finalize-request' },
  { method: 'POST', path: '/api/campaigns/:id/finalize-request' },
  { method: 'POST', path: '/api/campaigns/:id/payout/build' },
  { method: 'POST', path: '/api/campaign/:id/refund' },
];

/** Residuales P8G-11 (sin gate aún; PR-8b): deben seguir listados para no olvidarlos. */
const REQUIRED_UNAUTH_PAYOUT_SURFACE: MountedRoute[] = [
  { method: 'POST', path: '/api/campaign/:id/activate' },
  { method: 'POST', path: '/api/campaigns/:id/activate' },
  { method: 'POST', path: '/api/campaign/:id/payout' },
  { method: 'POST', path: '/api/campaigns/:id/payout' },
  { method: 'POST', path: '/api/campaigns/:id/payout/confirm' },
];

function setSqlite(): void {
  process.env.TEYOLIA_SQLITE_PATH = makeTestDbPath();
  process.env.CAMPAIGNS_DUAL_WRITE_JSON = '0';
}

async function loadApp() {
  // Fakes mínimos: createApp importa routers que tiran de Chronik al evaluar health, etc.
  vi.doMock('../blockchain/ecashClient', () => ({
    getEffectiveChronikBaseUrl: vi.fn(() => 'http://p8a05.invalid'),
    getUtxosForAddress: vi.fn().mockResolvedValue([]),
    getUtxosForScript: vi.fn().mockResolvedValue([]),
    getTipHeight: vi.fn().mockResolvedValue(0),
    broadcastTx: vi.fn().mockRejectedValue(new Error('p8a05: no broadcast')),
    broadcastRawTx: vi.fn().mockRejectedValue(new Error('p8a05: no broadcast')),
    getTransactionOutputs: vi.fn().mockResolvedValue([]),
    getTransactionInfo: vi.fn().mockRejectedValue(new Error('p8a05: sin Chronik')),
    getChronikBlockchainInfo: vi.fn().mockRejectedValue(new Error('p8a05: sin Chronik')),
    getBlockchainInfo: vi.fn().mockRejectedValue(new Error('p8a05: sin Chronik')),
    rpcCall: vi.fn().mockRejectedValue(new Error('p8a05: no rpc')),
    addressToScriptPubKey: vi.fn().mockResolvedValue('51'),
  }));
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('p8a05: red no permitida')));
  const { createApp } = await import('../app');
  return createApp();
}

describe('P8G-05: allowlist de rutas mutantes del stack Express', () => {
  beforeEach(() => {
    vi.resetModules();
    setSqlite();
    delete process.env.ENABLE_PUBLIC_BROADCAST;
    delete process.env.ENABLE_CAMPAIGN_FINALIZE;
    delete process.env.ENABLE_PUBLIC_REFUNDS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock('../blockchain/ecashClient');
  });

  it('el inventario POST/PUT/PATCH/DELETE coincide exactamente con la allowlist', async () => {
    const net = installDeniedNetwork();
    const app = await loadApp();
    const got = mutatingRoutes(listMountedRoutes(app)).map(routeKey);
    const expected = EXPECTED_MUTATING_ROUTES.map(routeKey).sort();
    expect(got).toEqual(expected);
    expectNetworkDeniedUnused(net);
  });

  it('las familias gateadas (broadcast/finalize/refund) están presentes', async () => {
    installDeniedNetwork();
    const app = await loadApp();
    const keys = new Set(mutatingRoutes(listMountedRoutes(app)).map(routeKey));
    for (const r of REQUIRED_GATED_MONETARY) {
      expect(keys.has(routeKey(r)), `falta ruta gateada ${routeKey(r)}`).toBe(true);
    }
  });

  it('la superficie payout/activate/confirm (P8G-11, PR-8b) sigue visible en el inventario', async () => {
    installDeniedNetwork();
    const app = await loadApp();
    const keys = new Set(mutatingRoutes(listMountedRoutes(app)).map(routeKey));
    for (const r of REQUIRED_UNAUTH_PAYOUT_SURFACE) {
      expect(keys.has(routeKey(r)), `falta superficie P8G-11 ${routeKey(r)}`).toBe(true);
    }
  });

  it('no hay PUT/PATCH/DELETE montados hoy (documenta el contrato actual)', async () => {
    installDeniedNetwork();
    const app = await loadApp();
    const odd = mutatingRoutes(listMountedRoutes(app)).filter((r) => r.method !== 'POST');
    expect(odd).toEqual([]);
  });
});
