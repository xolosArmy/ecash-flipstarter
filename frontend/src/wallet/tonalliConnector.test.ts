import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64Url, signAndBroadcastWithTonalli } from './tonalliConnector';

const ORIGIN = 'https://cartera.xolosarmy.xyz';

beforeEach(() => {
  (import.meta as any).env = {
    VITE_TONALLI_BRIDGE_URL: ORIGIN,
    VITE_TONALLI_BRIDGE_ORIGIN: ORIGIN,
    VITE_TONALLI_BRIDGE_PATH: '/#/external-sign',
    VITE_TONALLI_TIMEOUT_MS: '50',
  };
  if (!globalThis.crypto?.randomUUID) {
    (globalThis as any).crypto = { randomUUID: () => 'test-uuid' };
  }
});

function getRequestIdFromPopup(openMock: ReturnType<typeof vi.fn>) {
  const popupUrl = openMock.mock.calls[0][0] as string;
  const url = new URL(popupUrl);
  const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  const query = fragment.includes('?') ? fragment.split('?')[1] : url.search.slice(1);
  const requestParam = new URLSearchParams(query).get('request') as string;
  const payload = JSON.parse(decodeBase64Url(requestParam));
  return payload.requestId as string;
}

describe('signAndBroadcastWithTonalli', () => {
  it('returns error when popup is blocked', async () => {
    const openMock = vi.fn().mockReturnValue(null);
    (window as any).open = openMock;

    const result = await signAndBroadcastWithTonalli({
      kind: 'pledge',
      unsignedTxHex: '00',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Popup blocked');
    expect(result.popupUrl).toContain('/#/external-sign?request=');
  });

  it('ignores origin mismatch and resolves on matching origin', async () => {
    const popup = { closed: false, close: vi.fn() };
    const openMock = vi.fn().mockReturnValue(popup);
    (window as any).open = openMock;

    const promise = signAndBroadcastWithTonalli({
      kind: 'pledge',
      unsignedTxHex: '00',
    });

    const requestId = getRequestIdFromPopup(openMock);

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.example',
        data: { type: 'TONALLI_SIGN_RESULT', requestId, ok: true, txid: 'txid-1' },
      })
    );

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: ORIGIN,
        data: { type: 'TONALLI_SIGN_RESULT', requestId, ok: true, txid: 'txid-1' },
      })
    );

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.txid).toBe('txid-1');
  });

  it('times out when no response arrives', async () => {
    vi.useFakeTimers();
    const popup = { closed: false, close: vi.fn() };
    const openMock = vi.fn().mockReturnValue(popup);
    (window as any).open = openMock;

    const promise = signAndBroadcastWithTonalli({
      kind: 'pledge',
      unsignedTxHex: '00',
    });

    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout');
    vi.useRealTimers();
  });

  it('resolves on matching origin + requestId', async () => {
    const popup = { closed: false, close: vi.fn() };
    const openMock = vi.fn().mockReturnValue(popup);
    (window as any).open = openMock;

    const promise = signAndBroadcastWithTonalli({
      kind: 'pledge',
      unsignedTxHex: '00',
    });

    const requestId = getRequestIdFromPopup(openMock);

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: ORIGIN,
        data: { type: 'TONALLI_SIGN_RESULT', requestId, ok: true, txid: 'txid-2' },
      })
    );

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.txid).toBe('txid-2');
  });
});
