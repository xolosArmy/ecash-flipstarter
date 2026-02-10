import { resolveTonalliBridgeConfig } from './tonalliBridge';

export type TonalliSignRequest = {
  type: 'TONALLI_SIGN_REQUEST';
  requestId: string;
  kind: 'pledge' | 'finalize' | 'refund' | 'generic';
  campaignId?: string;
  returnOrigin: string;
  createdAt: number;
  unsignedTxHex: string;
};

export type TonalliSignResult = {
  type: 'TONALLI_SIGN_RESULT';
  requestId: string;
  ok: boolean;
  txid?: string;
  error?: string;
  popupUrl?: string;
};

const TXID_PATTERN = /^[0-9a-fA-F]{64}$/;

function isValidTxid(txid: string | undefined): txid is string {
  return typeof txid === 'string' && TXID_PATTERN.test(txid);
}

function notifyTonalliError(message: string) {
  console.error(`[tonalli] ${message}`);
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(message);
  }
}

export function encodeBase64Url(input: string): string {
  const base64 =
    typeof btoa === 'function'
      ? btoa(input)
      : Buffer.from(input, 'utf8').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return typeof atob === 'function'
    ? atob(padded)
    : Buffer.from(padded, 'base64').toString('utf8');
}

function getEnv() {
  return (import.meta as any).env || {};
}

// Legacy external-sign flow (fallback when WalletConnect is unavailable or fails).
export async function signAndBroadcastWithTonalli(
  req: Omit<TonalliSignRequest, 'type' | 'requestId' | 'returnOrigin' | 'createdAt'> & {
    unsignedTxHex: string;
  }
): Promise<TonalliSignResult> {
  const requestId = crypto.randomUUID();
  const tonalli = getTonalliWallet();
  if (tonalli) {
    try {
      const result = await tonalli.signAndBroadcast(req.unsignedTxHex);
      if (!isValidTxid(result?.txid)) {
        const message = 'Tonalli returned an invalid txid.';
        notifyTonalliError(message);
        return { type: 'TONALLI_SIGN_RESULT', requestId, ok: false, error: message };
      }
      return { type: 'TONALLI_SIGN_RESULT', requestId, ok: true, txid: result.txid };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Tonalli failed to sign and broadcast the tx.';
      notifyTonalliError(message);
      return { type: 'TONALLI_SIGN_RESULT', requestId, ok: false, error: message };
    }
  }

  const env = getEnv();
  const { baseUrl: bridgeUrl, origin: bridgeOrigin } = resolveTonalliBridgeConfig({ env });
  const rawBridgePath = env.VITE_TONALLI_BRIDGE_PATH || '/#/external-sign';
  const bridgePath = rawBridgePath === '/' ? '/#/external-sign' : rawBridgePath;
  const timeoutMs = Number(env.VITE_TONALLI_TIMEOUT_MS || 120000);

  const request: TonalliSignRequest = {
    type: 'TONALLI_SIGN_REQUEST',
    requestId,
    kind: req.kind,
    campaignId: req.campaignId,
    returnOrigin: window.location.origin,
    createdAt: Date.now(),
    unsignedTxHex: req.unsignedTxHex,
  };

  const payload = encodeBase64Url(JSON.stringify(request));
  const popupUrl = `${bridgeUrl}${bridgePath}?request=${payload}`;

  let popup: Window | null = null;
  try {
    popup = window.open(popupUrl, 'tonalli_sign', 'popup,width=480,height=720');
  } catch {
    popup = null;
  }

  if (!popup) {
    return {
      type: 'TONALLI_SIGN_RESULT',
      requestId,
      ok: false,
      error: 'Popup blocked',
      popupUrl,
    };
  }

  return new Promise((resolve) => {
    let resolved = false;
    let timeoutId: number | undefined;
    let closeInterval: number | undefined;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      if (closeInterval !== undefined) {
        clearInterval(closeInterval);
      }
      try {
        popup?.close();
      } catch {
        // ignore
      }
    };

    const finish = (result: TonalliSignResult) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== bridgeOrigin) return;
      const data = event.data as TonalliSignResult | undefined;
      if (!data || data.type !== 'TONALLI_SIGN_RESULT') return;
      if (data.requestId !== requestId) return;
      const validTxid = isValidTxid(data.txid);
      const ok = Boolean(data.ok) && validTxid;
      finish({
        type: 'TONALLI_SIGN_RESULT',
        requestId,
        ok,
        txid: validTxid ? data.txid : undefined,
        error: ok ? data.error : data.error || 'Invalid txid returned from Tonalli.',
      });
    };

    window.addEventListener('message', onMessage);

    timeoutId = window.setTimeout(() => {
      finish({
        type: 'TONALLI_SIGN_RESULT',
        requestId,
        ok: false,
        error: 'timeout',
      });
    }, timeoutMs);

    closeInterval = window.setInterval(() => {
      if (popup && popup.closed) {
        finish({
          type: 'TONALLI_SIGN_RESULT',
          requestId,
          ok: false,
          error: 'Window closed',
        });
      }
    }, 500);
  });
}

export interface WalletProvider {
  getAddress(): Promise<string>;
  signAndBroadcast(rawUnsignedHex: string): Promise<{ txid: string }>;
}

export function getTonalliWallet(): WalletProvider | null {
  if (typeof window === 'undefined') return null;
  const tonalliWallet = (window as any).tonalliWallet;
  if (!tonalliWallet) return null;

  return {
    getAddress: async () => await tonalliWallet.getAddress(),
    signAndBroadcast: async (rawUnsignedHex: string) => {
      const result = await tonalliWallet.signAndBroadcast(rawUnsignedHex);
      return { txid: result.txid };
    },
  };
}
