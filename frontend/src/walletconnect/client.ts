import type { SessionTypes } from '@walletconnect/types';
import { ensureWcInitialized, getWeb3Wallet } from './wcSingleton';
import { extractWalletTxid } from './txid';

const PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID as string | undefined;

export const WC_NAMESPACE = 'ecash' as const;
export const CHAIN_ID = 'ecash:1' as const;
export const WC_METHOD = 'ecash_signAndBroadcastTransaction' as const;
export const WC_METHOD_ALIAS = 'ecash_signAndBroadcast' as const;
const STORAGE_TOPIC = 'wc_topic';

export const REQUIRED_NAMESPACES = {
  [WC_NAMESPACE]: {
    chains: [CHAIN_ID],
    methods: [WC_METHOD, WC_METHOD_ALIAS],
    events: [] as string[],
  },
} as const;

let subscribed = false;
const sessionDeleteHandlers = new Set<(topic?: string) => void>();

export function isWalletConnectConfigured(): boolean {
  return Boolean(PROJECT_ID);
}

export function getWalletConnectProjectId(): string | null {
  return PROJECT_ID ?? null;
}

export function getRequestedNamespaces() {
  return {
    requiredNamespaces: REQUIRED_NAMESPACES,
    optionalNamespaces: REQUIRED_NAMESPACES,
  };
}

export function getStoredTopic(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(STORAGE_TOPIC);
}

export function storeTopic(topic: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_TOPIC, topic);
}

export function clearStoredTopic(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_TOPIC);
}

export function onSessionDelete(handler: (topic?: string) => void): () => void {
  sessionDeleteHandlers.add(handler);
  return () => {
    sessionDeleteHandlers.delete(handler);
  };
}

function notifySessionDelete(topic?: string) {
  sessionDeleteHandlers.forEach((handler) => {
    try {
      handler(topic);
    } catch {
      // no-op
    }
  });
}

export function getEcashAccounts(session?: SessionTypes.Struct): string[] {
  if (!session?.namespaces?.[WC_NAMESPACE]?.accounts) return [];
  return session.namespaces[WC_NAMESPACE].accounts
    .map((account) => account.split(':').slice(2).join(':'))
    .filter((address): address is string => Boolean(address));
}

function sessionSupportsRequiredCapabilities(session: SessionTypes.Struct, chainId: string): boolean {
  const ecashNamespace = session.namespaces?.[WC_NAMESPACE];
  if (!ecashNamespace) return false;

  const hasMethod =
    ecashNamespace.methods.includes(WC_METHOD) ||
    ecashNamespace.methods.includes(WC_METHOD_ALIAS);
  if (!hasMethod) return false;

  if (ecashNamespace.chains && ecashNamespace.chains.length > 0) {
    return ecashNamespace.chains.includes(chainId);
  }

  return ecashNamespace.accounts.some((account) => account.startsWith(`${chainId}:`));
}

export function assertSessionSupportsEcashSign(session: SessionTypes.Struct, chainId: string): void {
  if (!sessionSupportsRequiredCapabilities(session, chainId)) {
    throw new Error(
      `WalletConnect session is missing required chain/method (${chainId}, ${WC_METHOD}/${WC_METHOD_ALIAS}). Reconecta la wallet.`
    );
  }
}

export async function getSignClient() {
  const client = await ensureWcInitialized();
  if (!subscribed) {
    client.on('session_delete', (event) => {
      clearStoredTopic();
      notifySessionDelete(event?.topic);
    });
    subscribed = true;
  }
  return client;
}

export async function clearWalletConnectStorage(): Promise<void> {
  const client = getWeb3Wallet() ?? (await getSignClient());
  const storage = client.core?.storage as { removeAll?: () => Promise<void> } | undefined;
  if (storage?.removeAll) {
    await storage.removeAll();
  }
}

export async function connect(opts?: { onUri?: (uri: string) => void }): Promise<{
  session: SessionTypes.Struct;
  accounts: string[];
}> {
  const client = await getSignClient();
  const { requiredNamespaces, optionalNamespaces } = getRequestedNamespaces();
  const { uri, approval } = await client.connect({
    requiredNamespaces,
    optionalNamespaces,
  });
  if (uri) opts?.onUri?.(uri);
  const session = await approval();

  assertSessionSupportsEcashSign(session, CHAIN_ID);

  storeTopic(session.topic);
  return { session, accounts: getEcashAccounts(session) };
}

export async function disconnect(topic: string): Promise<void> {
  const client = await getSignClient();
  try {
    await client.disconnect({
      topic,
      reason: {
        code: 6000,
        message: 'User disconnected',
      },
    });
  } finally {
    clearStoredTopic();
    await clearWalletConnectStorage().catch(() => {
      // Best effort cleanup for stale walletconnect storage.
    });
  }
}

export async function requestSignAndBroadcastTransaction(
  topic: string,
  offerId: string,
  chainId: string,
  options?: {
    outputs?: Array<{ address: string; valueSats: number }>;
    userPrompt?: string;
  },
): Promise<unknown> {
  const client = await getSignClient();
  const session = client.session.get(topic);
  assertSessionSupportsEcashSign(session, chainId);
  const outputs = options?.outputs || [];
  const mode: 'legacy' | 'intent' = outputs.length > 0 ? 'intent' : 'legacy';
  const params = {
    offerId,
    userPrompt: options?.userPrompt || 'Donate to campaign',
    ...(options?.outputs && options.outputs.length > 0 ? { outputs: options.outputs } : {}),
  };
  const requestPayload = params as {
    mode?: unknown;
    rawHex?: unknown;
    outpoints?: unknown;
    outputs?: Array<{ valueSats?: unknown }>;
  };
  const requestOutputs = Array.isArray(requestPayload.outputs) ? requestPayload.outputs : [];
  const totalSats = requestOutputs.reduce((sum, output) => {
    const numericValue =
      typeof output.valueSats === 'bigint' ? Number(output.valueSats) : Number(output.valueSats);
    return Number.isFinite(numericValue) ? sum + numericValue : sum;
  }, 0);
  const rawHex = typeof requestPayload.rawHex === 'string' ? requestPayload.rawHex : '';
  const outpoints = Array.isArray(requestPayload.outpoints) ? requestPayload.outpoints : [];
  const requestMode = typeof requestPayload.mode === 'string' ? requestPayload.mode : mode;
  if (import.meta.env.DEV) {
    console.debug('[WC] ecash_signAndBroadcastTransaction request', {
      mode: requestMode,
      hasRawHex: Boolean(rawHex),
      hasOutpoints: outpoints.length > 0,
      outputsCount: requestOutputs.length,
      totalSats,
      rawHexLength: rawHex.length,
    });
  }

  // Activation intent mode sends business outputs only and lets the wallet build the final tx.
  const result = await client.request({
    topic,
    chainId,
    request: {
      method: WC_METHOD,
      params,
    },
  });
  if (import.meta.env.DEV) {
    console.debug('[WC] ecash_signAndBroadcastTransaction response', {
      mode,
      txid: extractWalletTxid(result),
    });
  }
  return result;
}
