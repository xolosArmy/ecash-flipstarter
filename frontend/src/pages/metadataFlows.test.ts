import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

const wallet = vi.hoisted(() => ({ initialize: vi.fn(), connect: vi.fn(), sign: vi.fn() }));
vi.mock('../walletconnect/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../walletconnect/client')>(),
  isWalletConnectConfigured: () => true,
  getSignClient: wallet.initialize,
  connect: wallet.connect,
  requestSignAndBroadcastTransaction: wallet.sign,
  onSessionDelete: () => () => {},
  getStoredTopic: () => null,
}));
const capabilities = {
  apiVersion: 'teyolia.metadata.v1', recordKind: 'metadata-only', monetaryEnabled: false,
  capabilities: { monetary: false },
};
const metadata = {
  ...capabilities, id: 'metadata-1', name: 'Propuesta local', description: 'Texto de planificación',
  goal: '123456789012345678901234567890', expiresAt: '2100-01-01T00:00:00.000Z',
  expirationTime: '4102444800000', createdAt: '2026-10-04T00:00:00.000Z', status: 'draft',
  planning: { thesis: 'Hipótesis revisable', evidence: ['Solo lectura'], proposedPnL: { projection: '100' } },
};
let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
async function mount(path: string) {
  window.history.replaceState({}, '', path);
  await act(async () => { root.render(React.createElement(App)); window.dispatchEvent(new PopStateEvent('popstate')); });
}
function setInput(name: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  wallet.initialize.mockResolvedValue({ session: { getAll: () => [] } });
  fetchMock = vi.fn().mockImplementation(async (url: string) => ({
    ok: true, json: async () => url.endsWith('/capabilities') ? capabilities : url.endsWith('/campaigns') ? [metadata] : metadata,
  }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function expectNoMoneyCalls() {
  expect(wallet.initialize).not.toHaveBeenCalled();
  expect(wallet.connect).not.toHaveBeenCalled();
  expect(wallet.sign).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => /activation|pledge|finalize|refund|broadcast/.test(url))).toEqual([]);
}
describe('metadata-only UI', () => {
  it('shows list metadata without summaries, wallet, fee, or simulated balances', async () => {
    await mount('/');
    expect(container.textContent).toContain('Modo no monetario');
    expect(container.textContent).toContain(metadata.goal);
    expect(container.querySelector('progress')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/summary'))).toBe(false);
    expectNoMoneyCalls();
  });
  it('reads planning inertly and does not offer activation for draft metadata', async () => {
    await mount('/campaigns/metadata-1');
    expect(container.textContent).toContain('Hipótesis revisable');
    expect(container.textContent).toContain('PnL propuesto');
    expect(container.textContent).toContain(metadata.goal);
    expect(container.textContent).not.toContain('Pagar fee');
    expect(container.querySelector('progress')).toBeNull();
    expectNoMoneyCalls();
  });
  it('creates metadata without a wallet and opens the returned record', async () => {
    await mount('/campaigns/create');
    await act(async () => {
      setInput('name', 'Nueva propuesta');
      setInput('goal', '0');
      setInput('expiresAt', '2099-01-01T12:00');
    });
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => ({
      ok: true, json: async () => options?.method === 'POST' ? metadata : url.endsWith('/capabilities') ? capabilities : metadata,
    }));
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body)).toEqual({ name: 'Nueva propuesta', goal: '0', description: '', expiresAt: new Date('2099-01-01T12:00').toISOString() });
    expect(window.location.pathname).toBe('/campaigns/metadata-1');
    expectNoMoneyCalls();
  });
  it('ignores stale wizard activation state and callback parameters in metadata mode', async () => {
    localStorage.setItem('wizard:lastCreatedCampaignId', 'metadata-1');
    localStorage.setItem('wizard:step', '2');
    await mount('/campaigns/create');
    expect(container.textContent).not.toContain('Pagar fee');
    await mount('/tonalli-callback?mode=activate&campaignId=metadata-1&txid=' + 'a'.repeat(64));
    expect(container.textContent).toContain('este callback no confirma pagos');
    expect(container.textContent).not.toContain('Broadcast successful');
    expect(localStorage.getItem('tonalli:txid:metadata-1')).toBeNull();
    expectNoMoneyCalls();
  });
  it('waits for capabilities without initializing Wallet or enabling a submit', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await mount('/campaigns/create');
    expect(container.textContent).toContain('Verificando modo');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    expectNoMoneyCalls();
  });
  it('rejects metadata returned in a callback even when the global backend is legacy-enabled', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true, json: async () => url.endsWith('/capabilities')
        ? { apiVersion: 'teyolia.legacy.v1', monetaryEnabled: true, capabilities: { monetary: true } }
        : { ...metadata, status: 'pending_verification', activationFeeTxid: 'a'.repeat(64) },
    }));
    await mount('/tonalli-callback?mode=activate&campaignId=metadata-1&txid=' + 'a'.repeat(64));
    expect(container.textContent).toContain('Registro de metadata');
    expect(fetchMock.mock.calls.some(([url]) => /activation|pledge|broadcast/.test(String(url)))).toBe(false);
    expect(wallet.connect).not.toHaveBeenCalled();
    expect(wallet.sign).not.toHaveBeenCalled();
    expect(localStorage.getItem('tonalli:txid:metadata-1')).toBeNull();
  });
  it('shows metadata records without claiming wallet ownership', async () => {
    await mount('/mis-campanas');
    expect(container.textContent).toContain('Se muestran todos los registros');
    expect(container.textContent).toContain(metadata.name);
    expectNoMoneyCalls();
  });
  it.each(['error', 'unknown'])('keeps creation and wallet disabled when capabilities are %s', async (mode) => {
    fetchMock.mockImplementation(async () => {
      if (mode === 'error') throw new Error('Unavailable');
      return { ok: true, json: async () => ({ monetaryEnabled: true, capabilities: { monetary: true } }) };
    });
    await mount('/campaigns/create');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    expect(container.textContent).toContain('No se pudo verificar');
    expectNoMoneyCalls();
  });
});
