import type { SessionTypes } from '@walletconnect/types';
import { ensureWcInitialized, getWeb3Wallet } from './wcSingleton';
import { extractWalletTxid } from './txid';

const PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID as string | undefined;

export const WC_NAMESPACE = 'ecash' as const;
export const CHAIN_ID = 'ecash:1' as const;
export const CHAIN_ID_ALIAS = 'ecash:mainnet' as const;
export const WC_METHOD = 'ecash_signAndBroadcastTransaction' as const;
export const WC_METHOD_ALIAS = 'ecash_signAndBroadcast' as const;
const STORAGE_TOPIC = 'wc_topic';

export const OPTIONAL_NAMESPACES = {
  [WC_NAMESPACE]: {
    chains: [CHAIN_ID, CHAIN_ID_ALIAS],
    methods: [WC_METHOD, WC_METHOD_ALIAS, 'ecash_getAddresses'],
    events: ['accountsChanged'],
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
    optionalNamespaces: OPTIONAL_NAMESPACES,
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
  const parsedAccounts = getParsedEcashAccounts(session);
  const preferredOrder = [CHAIN_ID, CHAIN_ID_ALIAS];
  const sorted = [...parsedAccounts].sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left.chainId);
    const rightIndex = preferredOrder.indexOf(right.chainId);
    const normalizedLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const normalizedRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    return normalizedLeft - normalizedRight;
  });

  const deduped = new Set<string>();
  sorted.forEach((account) => {
    if (account.address) deduped.add(account.address);
  });
  return [...deduped];
}

type EcashSessionDetails = {
  chains: string[];
  methods: string[];
  accounts: string[];
};

type ParsedEcashAccount = {
  chainId: string;
  address: string;
};

function getEcashSessionDetails(session?: SessionTypes.Struct): EcashSessionDetails {
  const ecashNamespace = session?.namespaces?.[WC_NAMESPACE];
  return {
    chains: Array.isArray(ecashNamespace?.chains)
      ? ecashNamespace.chains.filter((chain): chain is string => typeof chain === 'string')
      : [],
    methods: Array.isArray(ecashNamespace?.methods)
      ? ecashNamespace.methods.filter((method): method is string => typeof method === 'string')
      : [],
    accounts: Array.isArray(ecashNamespace?.accounts)
      ? ecashNamespace.accounts.filter((account): account is string => typeof account === 'string')
      : [],
  };
}

function parseEcashAccountEntry(account: string): ParsedEcashAccount | null {
  const [namespace, chainRef, ...addressParts] = account.split(':');
  if (namespace !== WC_NAMESPACE || !chainRef) return null;
  const address = addressParts.join(':');
  if (!address) return null;
  return {
    chainId: `${namespace}:${chainRef}`,
    address,
  };
}

function getParsedEcashAccounts(session?: SessionTypes.Struct): ParsedEcashAccount[] {
  const details = getEcashSessionDetails(session);
  return details.accounts
    .map((account) => parseEcashAccountEntry(account))
    .filter((account): account is ParsedEcashAccount => Boolean(account));
}

export function getEcashSessionDiagnostics(session?: SessionTypes.Struct): {
  detectedChains: string[];
  detectedMethods: string[];
} {
  const details = getEcashSessionDetails(session);
  const accountChains = getParsedEcashAccounts(session).map((account) => account.chainId);
  return {
    detectedChains: [...new Set([...details.chains, ...accountChains])],
    detectedMethods: [...new Set(details.methods)],
  };
}

function supportsEcashChain(session: SessionTypes.Struct, allowedChains: string[]): boolean {
  const details = getEcashSessionDetails(session);
  if (details.chains.some((chain) => allowedChains.includes(chain))) return true;
  const parsedAccounts = getParsedEcashAccounts(session);
  return parsedAccounts.some((account) => allowedChains.includes(account.chainId));
}

function supportsEcashMethod(session: SessionTypes.Struct): boolean {
  const details = getEcashSessionDetails(session);
  return details.methods.includes(WC_METHOD) || details.methods.includes(WC_METHOD_ALIAS);
}

export function isEcashSessionValid(session: SessionTypes.Struct): boolean {
  const allowedChains = [CHAIN_ID, CHAIN_ID_ALIAS];
  return supportsEcashMethod(session) && supportsEcashChain(session, allowedChains);
}

function sessionSupportsRequiredCapabilities(session: SessionTypes.Struct, chainId?: string): boolean {
  const allowedChains = chainId ? [chainId, CHAIN_ID, CHAIN_ID_ALIAS] : [CHAIN_ID, CHAIN_ID_ALIAS];
  return supportsEcashMethod(session) && supportsEcashChain(session, [...new Set(allowedChains)]);
}

export function assertSessionSupportsEcashSign(session: SessionTypes.Struct, chainId: string): void {
  if (!sessionSupportsRequiredCapabilities(session, chainId)) {
    const diagnostics = getEcashSessionDiagnostics(session);
    throw new Error(
      `WalletConnect session is missing required chain/method (${chainId}, ${WC_METHOD}/${WC_METHOD_ALIAS}). ` +
        `Detected chains: ${diagnostics.detectedChains.join(', ') || '(none)'}; ` +
        `detected methods: ${diagnostics.detectedMethods.join(', ') || '(none)'}. Reconecta la wallet.`
    );
  }
}

export function sessionSupportsEcashSigning(session: unknown, chainId?: string): boolean {
  try {
    assertSessionSupportsEcashSign(session as SessionTypes.Struct, chainId ?? CHAIN_ID);
    return true;
  } catch {
    return false;
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
  const { optionalNamespaces } = getRequestedNamespaces();
  const { uri, approval } = await client.connect({
    optionalNamespaces,
  });
  if (uri) opts?.onUri?.(uri);
  const session = await approval();

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
