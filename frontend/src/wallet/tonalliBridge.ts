type TonalliBridgeEnv = {
  VITE_TONALLI_BRIDGE_URL?: string;
  VITE_TONALLI_BASE_URL?: string;
  VITE_TONALLI_BRIDGE_ORIGIN?: string;
};

type TonalliBridgeOptions = {
  env?: TonalliBridgeEnv;
  hostname?: string;
};

export type TonalliBridgeConfig = {
  baseUrl: string;
  origin: string;
};

const DEFAULT_BRIDGE_URL = 'https://cartera.xolosarmy.xyz';
const LOCAL_BRIDGE_URL = 'http://127.0.0.1:5174';

let logged = false;

function getEnv(): TonalliBridgeEnv {
  return (import.meta as any).env || {};
}

function normalizeUrl(value?: string): string {
  return (value || '').trim().replace(/\/+$/, '');
}

function resolveHostname(options?: TonalliBridgeOptions): string {
  if (options?.hostname) return options.hostname;
  if (typeof window === 'undefined') return '';
  return window.location.hostname;
}

export function resolveTonalliBridgeBaseUrl(options?: TonalliBridgeOptions): string {
  const env = options?.env ?? getEnv();
  const rawBaseUrl =
    env.VITE_TONALLI_BRIDGE_URL || env.VITE_TONALLI_BASE_URL || DEFAULT_BRIDGE_URL;
  let baseUrl = normalizeUrl(rawBaseUrl);
  const hostname = resolveHostname(options);
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';

  if (isLocal) {
    const shouldOverride =
      baseUrl.includes('cartera.xolosarmy.xyz') || baseUrl.startsWith('https://');
    if (shouldOverride) {
      baseUrl = LOCAL_BRIDGE_URL;
    }
  }

  return baseUrl;
}

export function resolveTonalliBridgeOrigin(
  baseUrl?: string,
  options?: TonalliBridgeOptions
): string {
  const env = options?.env ?? getEnv();
  const rawOrigin = normalizeUrl(env.VITE_TONALLI_BRIDGE_ORIGIN);
  if (rawOrigin) {
    return rawOrigin;
  }
  const resolvedBaseUrl = baseUrl || resolveTonalliBridgeBaseUrl(options);
  return new URL(resolvedBaseUrl).origin;
}

export function resolveTonalliBridgeConfig(options?: TonalliBridgeOptions): TonalliBridgeConfig {
  const baseUrl = resolveTonalliBridgeBaseUrl(options);
  const origin = resolveTonalliBridgeOrigin(baseUrl, options);

  if (!logged && typeof window !== 'undefined') {
    logged = true;
    const hostname = resolveHostname(options);
    console.info('[tonalli] bridge config', { hostname, baseUrl, origin });
  }

  return { baseUrl, origin };
}
