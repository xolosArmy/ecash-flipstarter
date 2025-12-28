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

export async function signAndBroadcastWithTonalli(
  req: Omit<TonalliSignRequest, 'type' | 'requestId' | 'returnOrigin' | 'createdAt'> & {
    unsignedTxHex: string;
  }
): Promise<TonalliSignResult> {
  const env = getEnv();
  const { baseUrl: bridgeUrl, origin: bridgeOrigin } = resolveTonalliBridgeConfig({ env });
  const bridgePath = env.VITE_TONALLI_BRIDGE_PATH || '/#/external-sign';
  const timeoutMs = Number(env.VITE_TONALLI_TIMEOUT_MS || 120000);

  const requestId = crypto.randomUUID();
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
      finish({
        type: 'TONALLI_SIGN_RESULT',
        requestId,
        ok: Boolean(data.ok),
        txid: data.txid,
        error: data.error,
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
  console.warn('Tonalli wallet connector not implemented yet.');
  return null;
}
