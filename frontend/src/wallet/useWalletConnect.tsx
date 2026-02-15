import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type SignClient from '@walletconnect/sign-client';
import type { SessionTypes } from '@walletconnect/types';
import {
  assertSessionSupportsEcashSign,
  CHAIN_ID,
  clearWalletConnectStorage,
  clearStoredTopic,
  connect as wcConnect,
  disconnect as wcDisconnect,
  getEcashAccounts,
  getRequestedNamespaces,
  getSignClient,
  getStoredTopic,
  getWalletConnectProjectId,
  isWalletConnectConfigured,
  onSessionDelete,
  requestSignAndBroadcastTransaction,
  sessionSupportsEcashSigning,
} from '../walletconnect/client';

type WalletConnectState = {
  signClient: SignClient | null;
  connected: boolean;
  topic: string | null;
  addresses: string[];
  lastTxid: string | null;
  uri: string | null;
  status: 'idle' | 'connecting' | 'awaiting' | 'connected' | 'signing';
  error: string | null;
  projectIdMissing: boolean;
  connect: () => Promise<SessionTypes.Struct | null>;
  disconnect: () => Promise<void>;
  requestAddresses: () => Promise<string[]>;
  requestSignAndBroadcast: (
    offerId: string,
    chainId: string,
    options?: {
      outputs?: Array<{ address: string; valueSats: number }>;
      userPrompt?: string;
    }
  ) => Promise<unknown>;
  setLastTxid: (txid: string | null) => void;
};

const WalletConnectContext = createContext<WalletConnectState | null>(null);
const INVALID_SESSION_MESSAGE = 'Sesión WalletConnect inválida. Desconecta y vuelve a conectar.';

function formatWalletConnectError(err: unknown, fallback: string) {
  if (err && typeof err === 'object') {
    const maybeCode = (err as { code?: number }).code;
    if (maybeCode === 4001) return 'Solicitud rechazada por el usuario.';
  }
  if (err instanceof Error) {
    const message = err.message || fallback;
    const lower = message.toLowerCase();
    if (lower.includes('rejected')) return 'Solicitud rechazada por el usuario.';
    if (lower.includes('timeout')) return 'Tiempo de espera agotado en WalletConnect.';
    if (lower.includes('no matching key') || lower.includes("session topic doesn't exist")) {
      return INVALID_SESSION_MESSAGE;
    }
    return message;
  }
  return fallback;
}

function isStaleSessionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const lower = err.message.toLowerCase();
  return lower.includes('no matching key') || lower.includes("session topic doesn't exist");
}

function safelyGetSession(client: SignClient, topic: string): SessionTypes.Struct | null {
  try {
    return client.session.get(topic);
  } catch {
    return null;
  }
}

export const WalletConnectProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const clientRef = useRef<SignClient | null>(null);
  const [signClient, setSignClient] = useState<SignClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [topic, setTopic] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [lastTxid, setLastTxid] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [status, setStatus] = useState<WalletConnectState['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [projectIdMissing, setProjectIdMissing] = useState(!isWalletConnectConfigured());

  useEffect(() => {
    if (import.meta.env.DEV) {
      console.info('[wc] projectId present?', Boolean(getWalletConnectProjectId()));
    }
  }, []);

  const resetState = () => {
    setConnected(false);
    setTopic(null);
    setAddresses([]);
    setUri(null);
    setStatus('idle');
    setLastTxid(null);
  };

  const purgeWalletConnect = async () => {
    clearStoredTopic();
    await clearWalletConnectStorage().catch(() => {
      // Best effort cleanup for stale walletconnect storage.
    });
    resetState();
    setTopic(null);
    setStatus('idle');
    setError(INVALID_SESSION_MESSAGE);
    if (import.meta.env.DEV) {
      console.debug('[WC] purge complete');
    }
  };

  useEffect(() => {
    if (import.meta.env.DEV) {
      const namespaces = getRequestedNamespaces();
      console.debug('[walletconnect] proposed namespaces', namespaces);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const setup = async () => {
      if (!isWalletConnectConfigured()) {
        setProjectIdMissing(true);
        setError('No projectId found for WalletConnect (VITE_WC_PROJECT_ID).');
        return;
      }
      setProjectIdMissing(false);
      try {
        const client = await getSignClient();
        if (!active) return;
        clientRef.current = client;
        setSignClient(client);

        const unsubscribe = onSessionDelete(() => {
          clearStoredTopic();
          resetState();
        });

        const storedTopic = getStoredTopic();
        if (storedTopic) {
          if (import.meta.env.DEV) {
            console.debug('[WC] restore topic', storedTopic);
          }
          const session =
            safelyGetSession(client, storedTopic) ??
            client.session.getAll().find((existingSession) => existingSession.topic === storedTopic) ??
            null;
          if (session) {
            assertSessionSupportsEcashSign(session, CHAIN_ID);
            setTopic(session.topic);
            setConnected(true);
            setStatus('connected');
            setAddresses(getEcashAccounts(session));
          } else {
            if (import.meta.env.DEV) {
              console.debug('[WC] stale topic detected -> purge');
            }
            await purgeWalletConnect();
            return () => unsubscribe();
          }
        }

        return () => unsubscribe();
      } catch (err) {
        if (!active) return;
        if (isStaleSessionError(err)) {
          await purgeWalletConnect();
          return;
        }
        setError(formatWalletConnectError(err, 'WalletConnect init failed.'));
      }
    };

    let cleanup: (() => void) | undefined;
    setup().then((result) => {
      cleanup = typeof result === 'function' ? result : undefined;
    });

    return () => {
      active = false;
      if (cleanup) cleanup();
    };
  }, []);

  const connect = async (): Promise<SessionTypes.Struct | null> => {
    setError(null);
    setStatus('connecting');
    try {
      const { session, accounts } = await wcConnect({
        onUri: (nextUri) => {
          setUri(nextUri);
          setStatus('awaiting');
        },
      });

      if (!sessionSupportsEcashSigning(session)) {
        setStatus('idle');
        setError('La sesión no incluye ecash:1 + ecash_signAndBroadcastTransaction. Reconecta Tonalli.');
        return null;
      }
      setTopic(session.topic);
      setConnected(true);
      setStatus('connected');
      setUri(null);
      setAddresses(accounts);
      return session;
    } catch (err) {
      if (isStaleSessionError(err)) {
        await purgeWalletConnect();
        throw new Error(INVALID_SESSION_MESSAGE);
      }
      setStatus('idle');
      setUri(null);
      setError(formatWalletConnectError(err, 'WalletConnect connect failed.'));
      return null;
    }
  };

  const disconnect = async () => {
    if (!topic) return;
    try {
      await wcDisconnect(topic);
    } catch (err) {
      setError(formatWalletConnectError(err, 'WalletConnect disconnect failed.'));
    } finally {
      clearStoredTopic();
      resetState();
    }
  };

  const requestAddresses = async () => {
    const existingTopic = topic;
    const client = clientRef.current;
    if (!existingTopic || !client) return [];
    const session = safelyGetSession(client, existingTopic);
    const next = getEcashAccounts(session ?? undefined);
    setAddresses(next);
    return next;
  };

  const requestSignAndBroadcast = async (
    offerId: string,
    chainId: string,
    options?: {
      outputs?: Array<{ address: string; valueSats: number }>;
      userPrompt?: string;
    }
  ) => {
    if (!topic) throw new Error('No WalletConnect session.');

    const client = clientRef.current;
    if (!client) throw new Error('WalletConnect client not initialized.');
    const session = safelyGetSession(client, topic);
    if (!session) {
      throw new Error('WalletConnect session expired. Reconecta la wallet.');
    }
    assertSessionSupportsEcashSign(session, chainId || CHAIN_ID);

    setStatus('signing');
    try {
      const result = await requestSignAndBroadcastTransaction(topic, offerId, chainId || CHAIN_ID, options);
      setStatus('connected');
      return result;
    } catch (err) {
      if (isStaleSessionError(err)) {
        await purgeWalletConnect();
        throw new Error(INVALID_SESSION_MESSAGE);
      }
      setStatus('connected');
      const formattedError = formatWalletConnectError(err, 'WalletConnect request failed.');
      setError(formattedError);
      throw new Error(formattedError);
    }
  };

  const value = useMemo<WalletConnectState>(
    () => ({
      signClient,
      connected,
      topic,
      addresses,
      lastTxid,
      uri,
      status,
      error,
      projectIdMissing,
      connect,
      disconnect,
      requestAddresses,
      requestSignAndBroadcast,
      setLastTxid,
    }),
    [signClient, connected, topic, addresses, lastTxid, uri, status, error, projectIdMissing]
  );

  return <WalletConnectContext.Provider value={value}>{children}</WalletConnectContext.Provider>;
};

export function useWalletConnect(): WalletConnectState {
  const ctx = useContext(WalletConnectContext);
  if (!ctx) {
    throw new Error('useWalletConnect must be used within WalletConnectProvider');
  }
  return ctx;
}
