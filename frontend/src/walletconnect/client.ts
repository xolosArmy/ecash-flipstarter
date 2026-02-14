import SignClient from '@walletconnect/sign-client';
import type { SessionTypes } from '@walletconnect/types';
import { CHAIN_ID, OPTIONAL_NAMESPACES, REQUIRED_METHOD } from './config';

const PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID as string | undefined;
const APP_NAME = (import.meta.env.VITE_WC_APP_NAME as string | undefined) || 'Flipstarter 2.0';
const APP_URL =
  (import.meta.env.VITE_WC_APP_URL as string | undefined) ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173');
const STORAGE_TOPIC = 'wc_topic';
let clientPromise: Promise<SignClient> | null = null;
let subscribed = false;
const sessionDeleteHandlers = new Set<(topic?: string) => void>();

export function isWalletConnectConfigured(): boolean {
  return Boolean(PROJECT_ID);
}

export function getWalletConnectProjectId(): string | undefined {
  return PROJECT_ID;
}

export function getOptionalNamespaces() {
  return OPTIONAL_NAMESPACES;
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

export function sessionSupportsEcashSigning(session: SessionTypes.Struct): boolean {
  const namespace = session.namespaces?.ecash;
  if (!namespace) return false;
  const hasChain = (namespace.chains ?? []).includes(CHAIN_ID)
    || (namespace.accounts ?? []).some((account) => account.startsWith(`${CHAIN_ID}:`));
  const hasMethod = namespace.methods?.includes(REQUIRED_METHOD);
  return Boolean(hasChain && hasMethod);
}

export async function getSignClient(): Promise<SignClient> {
  if (!PROJECT_ID) {
    throw new Error('No projectId found. Configura VITE_WC_PROJECT_ID.');
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

export function getEcashAccounts(session?: SessionTypes.Struct): string[] {
  if (!session?.namespaces?.ecash?.accounts) return [];
  return session.namespaces.ecash.accounts
    .map((account) => account.split(':').slice(2).join(':'))
    .filter((address): address is string => Boolean(address));
}

export async function connect(opts?: { onUri?: (uri: string) => void }): Promise<{
  session: SessionTypes.Struct;
  accounts: string[];
}> {
  const client = await getSignClient();
  if (import.meta.env.DEV) {
    console.info('[wc] optionalNamespaces', OPTIONAL_NAMESPACES);
  }
  const { uri, approval } = await client.connect({
    optionalNamespaces: OPTIONAL_NAMESPACES,
  });
  if (uri) opts?.onUri?.(uri);
  const session = await approval();
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
): Promise<unknown> {
  const client = await getSignClient();
  return client.request({
    topic,
    chainId,
    request: {
      method: REQUIRED_METHOD,
      params: {
        offerId,
        userPrompt: 'Donate to campaign',
        keys: [],
      },
    },
  });
}

export { CHAIN_ID, REQUIRED_METHOD, OPTIONAL_NAMESPACES };
