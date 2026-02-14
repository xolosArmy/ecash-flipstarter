import SignClient from '@walletconnect/sign-client';
import type { SessionTypes } from '@walletconnect/types';
import { CHAIN_ID, OPTIONAL_NAMESPACES, REQUIRED_METHOD } from './config';

const PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID as string | undefined;
console.log('WC projectId:', import.meta.env.VITE_WC_PROJECT_ID);
const APP_NAME = (import.meta.env.VITE_WC_APP_NAME as string | undefined) || 'Flipstarter 2.0';
const APP_URL =
  (import.meta.env.VITE_WC_APP_URL as string | undefined) ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173');

export const WC_NAMESPACE = 'ecash' as const;
export const CHAIN_ID = 'ecash:1' as const;
export const WC_METHOD = 'ecash_signAndBroadcastTransaction' as const;
const STORAGE_TOPIC = 'wc_topic';

export const REQUIRED_NAMESPACES = {
  [WC_NAMESPACE]: {
    chains: [CHAIN_ID],
    methods: [WC_METHOD],
    events: [] as string[],
  },
} as const;

let clientPromise: Promise<SignClient> | null = null;
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

  const hasMethod = ecashNamespace.methods.includes(WC_METHOD);
  if (!hasMethod) return false;

  if (ecashNamespace.chains && ecashNamespace.chains.length > 0) {
    return ecashNamespace.chains.includes(chainId);
  }

  return ecashNamespace.accounts.some((account) => account.startsWith(`${chainId}:`));
}

export function assertSessionSupportsEcashSign(session: SessionTypes.Struct, chainId: string): void {
  if (!sessionSupportsRequiredCapabilities(session, chainId)) {
    throw new Error(
      `WalletConnect session is missing required chain/method (${chainId}, ${WC_METHOD}). Reconecta la wallet.`
    );
  }
}

export async function getSignClient(): Promise<SignClient> {
  if (!PROJECT_ID) {
    throw new Error('No projectId found for WalletConnect (VITE_WC_PROJECT_ID).');
  }
  if (!clientPromise) {
    const iconUrl = APP_URL ? `${APP_URL}/favicon.ico` : undefined;
    clientPromise = SignClient.init({
      projectId: PROJECT_ID,
      metadata: {
        name: APP_NAME,
        description: 'Flipstarter 2.0 WalletConnect signer',
        url: APP_URL,
        icons: iconUrl ? [iconUrl] : [],
      },
    });
  }
  const client = await clientPromise;
  if (!subscribed) {
    client.on('session_delete', (event) => {
      clearStoredTopic();
      notifySessionDelete(event?.topic);
    });
    subscribed = true;
  }
  return client;
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
  await client.disconnect({
    topic,
    reason: {
      code: 6000,
      message: 'User disconnected',
    },
  });
  clearStoredTopic();
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

  // Activation intent mode sends business outputs only and lets the wallet build the final tx.
  return client.request({
    topic,
    chainId,
    request: {
      method: WC_METHOD,
      params: {
        offerId,
        userPrompt: options?.userPrompt || 'Donate to campaign',
        ...(options?.outputs && options.outputs.length > 0 ? { outputs: options.outputs } : {}),
      },
    },
  });
}
