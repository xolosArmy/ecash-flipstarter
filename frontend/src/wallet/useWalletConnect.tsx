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
  getEcashSessionDiagnostics,
  getPreferredEcashChain,
  getRequestedNamespaces,
  getSignClient,
  getStoredTopic,
  getWalletConnectProjectId,
  isEcashSessionValid,
  isWalletConnectConfigured,
  onSessionDelete,
  WC_METHOD,
  WC_METHOD_GET_ADDRESSES,
  WC_METHOD_SIGN_MESSAGE,
  requestSignAndBroadcastTransaction,
} from '../walletconnect/client';
import {
  buildTonalliPublicKeyRequest,
  extractSessionEcashPublicKey,
  normalizeCompressedSecp256k1PublicKey,
  readDisclosedEcashPublicKey,
} from './ecashPublicKey';
import {
  normalizeAlpTokenPayload,
  normalizeTokenOutputs,
  type TokenOutputLike,
  type WalletConnectTokenOutput,
} from '../types/tokenOutput';

type WalletConnectState = {
  signClient: SignClient | null;
  connected: boolean;
  topic: string | null;
  addresses: string[];
  /** Clave pública comprimida secp256k1 de la cuenta ecash: conectada. */
  publicKey: string | null;
  lastTxid: string | null;
  uri: string | null;
  status: 'idle' | 'connecting' | 'awaiting' | 'connected' | 'signing';
  error: string | null;
  projectIdMissing: boolean;
  connect: () => Promise<SessionTypes.Struct | null>;
  disconnect: () => Promise<void>;
  resetSession: () => Promise<void>;
  requestAddresses: () => Promise<string[]>;
  requestAccountPublicKey: () => Promise<string | null>;
  requestSignAndBroadcast: (
    offerId: string,
    chainId: string,
    options?: {
      outputs?: TokenOutputLike[];
      userPrompt?: string;
    }
  ) => Promise<unknown>;
  requestSignAndBroadcastIntent: (args: {
    offerId: string;
    outputs: TokenOutputLike[];
    message?: string;
    userPrompt?: string;
  }) => Promise<{ txid: string }>;
  requestSignAndBroadcastRawTx: (args: {
    offerId: string;
    rawHex: string;
    userPrompt?: string;
  }) => Promise<{ txid: string }>;
  setLastTxid: (txid: string | null) => void;
};

const WalletConnectContext = createContext<WalletConnectState | null>(null);
const INVALID_SESSION_MESSAGE = 'Sesión WalletConnect inválida. Desconecta y vuelve a conectar.';
const INVALID_SESSION_RECONNECT_MESSAGE = 'La sesión WalletConnect no es compatible. Resetea y reconecta Tonalli.';

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

function extractTxid(result: unknown): string | null {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'txid' in result) {
    const txid = (result as { txid?: unknown }).txid;
    return typeof txid === 'string' ? txid : null;
  }
  return null;
}

function formatInvalidEcashSessionMessage(session: SessionTypes.Struct): string {
  const diagnostics = getEcashSessionDiagnostics(session);
  const chains = diagnostics.detectedChains.join(', ') || '(ninguna)';
  const methods = diagnostics.detectedMethods.join(', ') || '(ninguno)';
  return `${INVALID_SESSION_RECONNECT_MESSAGE} Chains detectadas: ${chains}. Methods detectados: ${methods}.`;
}

export function normalizeWalletConnectOutputs(outputs: TokenOutputLike[]): WalletConnectTokenOutput[] {
  const normalized: WalletConnectTokenOutput[] = [];
  for (const output of normalizeTokenOutputs(outputs, {
    fallbackProtocol: true,
    stringifyValueSats: true,
  })) {
    const token = output.token
      ? normalizeAlpTokenPayload(output.token, { fallbackProtocol: true })
      : undefined;
    if (output.token && !token) {
      continue;
    }
    normalized.push({
      address: output.address,
      valueSats: String(output.valueSats),
      ...(token ? { token } : {}),
    });
  }
  return normalized;
}

export const WalletConnectProvider: React.FC<{ children: React.ReactNode; enabled?: boolean }> = ({ children, enabled = false }) => {
  const clientRef = useRef<SignClient | null>(null);
  const [signClient, setSignClient] = useState<SignClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [topic, setTopic] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [lastTxid, setLastTxid] = useState<string | null>(null);
  const topicRef = useRef<string | null>(null);
  const publicKeyRef = useRef<string | null>(null);
  const addressesRef = useRef<string[]>([]);
  const [uri, setUri] = useState<string | null>(null);
  const [status, setStatus] = useState<WalletConnectState['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [projectIdMissing, setProjectIdMissing] = useState(enabled && !isWalletConnectConfigured());

  useEffect(() => {
    if (enabled && import.meta.env.DEV) {
      console.info('[wc] projectId present?', Boolean(getWalletConnectProjectId()));
    }
  }, []);

  const assignTopic = (next: string | null) => {
    topicRef.current = next;
    setTopic(next);
  };

  const rememberPublicKey = (next: string | null) => {
    const normalized = normalizeCompressedSecp256k1PublicKey(next);
    publicKeyRef.current = normalized;
    setPublicKey(normalized);
  };

  const rememberSessionIdentity = (
    session: SessionTypes.Struct | null | undefined,
    options?: { acceptPublicKey?: boolean },
  ) => {
    const nextAddresses = getEcashAccounts(session ?? undefined);
    addressesRef.current = nextAddresses;
    setAddresses(nextAddresses);
    rememberPublicKey(options?.acceptPublicKey === false ? null : extractSessionEcashPublicKey(session));
  };

  const resetState = () => {
    setConnected(false);
    assignTopic(null);
    addressesRef.current = [];
    setAddresses([]);
    rememberPublicKey(null);
    setUri(null);
    setStatus('idle');
    setLastTxid(null);
  };

  const purgeWalletConnect = async (nextError: string | null = INVALID_SESSION_MESSAGE) => {
    clearStoredTopic();
    await clearWalletConnectStorage().catch(() => {
      // Best effort cleanup for stale walletconnect storage.
    });
    resetState();
    assignTopic(null);
    setStatus('idle');
    setError(nextError);
    if (import.meta.env.DEV) {
      console.debug('[WC] purge complete');
    }
  };

  useEffect(() => {
    if (enabled && import.meta.env.DEV) {
      const namespaces = getRequestedNamespaces();
      console.debug('[walletconnect] proposed namespaces', namespaces);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
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
            if (!isEcashSessionValid(session)) {
              assignTopic(session.topic);
              setConnected(false);
              setStatus('idle');
              rememberSessionIdentity(session, { acceptPublicKey: false });
              setError(formatInvalidEcashSessionMessage(session));
              return () => unsubscribe();
            }
            assignTopic(session.topic);
            setConnected(true);
            setStatus('connected');
            rememberSessionIdentity(session);
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
  }, [enabled]);

  const connect = async (): Promise<SessionTypes.Struct | null> => {
    if (!enabled) throw new Error('Modo no monetario: WalletConnect deshabilitado.');
    setError(null);
    setStatus('connecting');
    try {
      const { session } = await wcConnect({
        onUri: (nextUri) => {
          setUri(nextUri);
          setStatus('awaiting');
        },
      });

      if (!isEcashSessionValid(session)) {
        assignTopic(session.topic);
        setConnected(false);
        rememberSessionIdentity(session, { acceptPublicKey: false });
        setStatus('idle');
        setError(formatInvalidEcashSessionMessage(session));
        return null;
      }
      assignTopic(session.topic);
      setConnected(true);
      setStatus('connected');
      setUri(null);
      rememberSessionIdentity(session);
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

  const resetSession = async () => {
    await purgeWalletConnect(null);
  };

  const requestAddresses = async () => {
    const existingTopic = topic;
    const client = clientRef.current;
    if (!existingTopic || !client) return [];
    const session = safelyGetSession(client, existingTopic);
    const next = getEcashAccounts(session ?? undefined);
    addressesRef.current = next;
    setAddresses(next);
    if (session && isEcashSessionValid(session)) {
      rememberPublicKey(extractSessionEcashPublicKey(session));
    }
    return next;
  };

  const requestDisclosedPublicKey = async (method: string, params: Record<string, unknown>) => {
    const activeTopic = topicRef.current;
    const client = clientRef.current;
    if (!activeTopic || !client) return null;
    const session = safelyGetSession(client, activeTopic);
    if (!session) return null;
    const chainId = getPreferredEcashChain(session) ?? CHAIN_ID;
    const result = await client.request({
      topic: activeTopic,
      chainId,
      request: { method, params },
    });
    const accounts = getEcashAccounts(session);
    addressesRef.current = accounts;
    setAddresses(accounts);
    const disclosed = readDisclosedEcashPublicKey(result, accounts);
    if (disclosed.publicKey && !disclosed.addressMatches) {
      throw new Error('La clave pública de Tonalli no corresponde a la cuenta conectada. Reconecta Tonalli.');
    }
    if (!disclosed.publicKey) return null;
    rememberPublicKey(disclosed.publicKey);
    return disclosed.publicKey;
  };

  const requestAccountPublicKey = async (): Promise<string | null> => {
    const cached = normalizeCompressedSecp256k1PublicKey(publicKeyRef.current);
    if (cached) return cached;

    const activeTopic = topicRef.current;
    const client = clientRef.current;
    if (!activeTopic || !client) return null;
    const session = safelyGetSession(client, activeTopic);
    if (!session || !isEcashSessionValid(session)) return null;

    const fromSession = extractSessionEcashPublicKey(session);
    if (fromSession) {
      rememberPublicKey(fromSession);
      return fromSession;
    }

    const methods = getEcashSessionDiagnostics(session).detectedMethods;
    if (methods.includes(WC_METHOD_GET_ADDRESSES)) {
      try {
        const listed = await requestDisclosedPublicKey(WC_METHOD_GET_ADDRESSES, {});
        if (listed) return listed;
      } catch (err) {
        if (isStaleSessionError(err)) {
          await purgeWalletConnect();
          throw new Error(INVALID_SESSION_MESSAGE);
        }
        if (err instanceof Error && err.message.includes('no corresponde')) {
          throw err;
        }
      }
    }

    if (!methods.includes(WC_METHOD_SIGN_MESSAGE)) return null;

    setStatus('signing');
    try {
      const disclosed = await requestDisclosedPublicKey(
        WC_METHOD_SIGN_MESSAGE,
        buildTonalliPublicKeyRequest().params,
      );
      setStatus('connected');
      if (!disclosed) {
        throw new Error('Tonalli no devolvió la clave pública comprimida de la cuenta conectada.');
      }
      return disclosed;
    } catch (err) {
      if (isStaleSessionError(err)) {
        await purgeWalletConnect();
        throw new Error(INVALID_SESSION_MESSAGE);
      }
      setStatus('connected');
      if (err instanceof Error && err.message.includes('no corresponde')) {
        setError(err.message);
        throw err;
      }
      if (err instanceof Error && err.message.includes('no devolvió')) {
        setError(err.message);
        throw err;
      }
      const formattedError = formatWalletConnectError(err, 'No se pudo obtener la clave pública de Tonalli.');
      setError(formattedError);
      const lower = formattedError.toLowerCase();
      if (lower.includes('method') || lower.includes('método') || lower.includes('metodo')) {
        throw new Error(`${formattedError} Reconecta Tonalli.`);
      }
      throw new Error(formattedError);
    }
  };

  const requestSignAndBroadcast = async (
    offerId: string,
    chainId: string,
    options?: {
      outputs?: TokenOutputLike[];
      userPrompt?: string;
    }
  ) => {
    if (!enabled) throw new Error('Modo no monetario: firma deshabilitada.');
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
      const normalizedOutputs = options?.outputs ? normalizeWalletConnectOutputs(options.outputs) : undefined;
      const result = await requestSignAndBroadcastTransaction(topic, offerId, chainId || CHAIN_ID, {
        ...(normalizedOutputs ? { outputs: normalizedOutputs } : {}),
        ...(options?.userPrompt ? { userPrompt: options.userPrompt } : {}),
      });
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

  const requestSignAndBroadcastIntent = async (args: {
    offerId: string;
    outputs: TokenOutputLike[];
    message?: string;
    userPrompt?: string;
  }): Promise<{ txid: string }> => {
    if (!enabled) throw new Error('Modo no monetario: firma deshabilitada.');
    const activeTopic = topic;
    const client = clientRef.current;
    if (!activeTopic || !client) {
      throw new Error('Conecta WalletConnect');
    }

    const session = safelyGetSession(client, activeTopic);
    if (!session) {
      throw new Error('Conecta WalletConnect');
    }
    assertSessionSupportsEcashSign(session, CHAIN_ID);

    setStatus('signing');
    try {
      const normalizedOutputs = normalizeWalletConnectOutputs(args.outputs);
      const result = await client.request({
        topic: activeTopic,
        chainId: CHAIN_ID,
        request: {
          method: WC_METHOD,
          params: [
            {
              mode: 'intent',
              offerId: args.offerId,
              outputs: normalizedOutputs,
              ...(args.message ? { message: args.message } : {}),
              ...(args.userPrompt ? { userPrompt: args.userPrompt } : {}),
              meta: { app: 'ecash-flipstarter', flow: 'pledge' },
            },
          ],
        },
      });
      const txid = extractTxid(result);
      if (!txid) {
        throw new Error('WalletConnect response missing txid.');
      }
      setStatus('connected');
      return { txid };
    } catch (err) {
      if (isStaleSessionError(err)) {
        await purgeWalletConnect();
      }
      setStatus('connected');
      const formattedError = formatWalletConnectError(err, 'WalletConnect request failed.');
      setError(formattedError);
      throw new Error(formattedError);
    }
  };

  const requestSignAndBroadcastRawTx = async (args: {
    offerId: string;
    rawHex: string;
    userPrompt?: string;
  }): Promise<{ txid: string }> => {
    if (!enabled) throw new Error('Modo no monetario: firma deshabilitada.');
    const activeTopic = topic;
    const client = clientRef.current;
    if (!activeTopic || !client) {
      throw new Error('Conecta WalletConnect');
    }

    const session = safelyGetSession(client, activeTopic);
    if (!session) {
      throw new Error('Conecta WalletConnect');
    }
    assertSessionSupportsEcashSign(session, CHAIN_ID);

    setStatus('signing');
    try {
      const result = await client.request({
        topic: activeTopic,
        chainId: CHAIN_ID,
        request: {
          method: WC_METHOD,
          params: [
            {
              mode: 'tx',
              offerId: args.offerId,
              rawHex: args.rawHex,
              ...(args.userPrompt ? { userPrompt: args.userPrompt } : {}),
              meta: { app: 'ecash-flipstarter', flow: 'payout' },
            },
          ],
        },
      });
      const txid = extractTxid(result);
      if (!txid) {
        throw new Error('WalletConnect response missing txid.');
      }
      setStatus('connected');
      return { txid };
    } catch (err) {
      if (isStaleSessionError(err)) {
        await purgeWalletConnect();
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
      publicKey,
      lastTxid,
      uri,
      status,
      error,
      projectIdMissing,
      connect,
      disconnect,
      resetSession,
      requestAddresses,
      requestAccountPublicKey,
      requestSignAndBroadcast,
      requestSignAndBroadcastIntent,
      requestSignAndBroadcastRawTx,
      setLastTxid,
    }),
    [
      signClient,
      connected,
      topic,
      addresses,
      publicKey,
      lastTxid,
      uri,
      status,
      error,
      projectIdMissing,
      requestSignAndBroadcastIntent,
      requestSignAndBroadcastRawTx,
      resetSession,
    ]
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
