import { Core } from '@walletconnect/core';
import SignClient from '@walletconnect/sign-client';

const PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID as string | undefined;
const APP_NAME = (import.meta.env.VITE_WC_APP_NAME as string | undefined) || 'Flipstarter 2.0';
const APP_URL =
  (import.meta.env.VITE_WC_APP_URL as string | undefined) ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173');

type WcSingletonState = {
  core?: Core;
  web3wallet?: SignClient;
  inited?: boolean;
  initPromise?: Promise<SignClient>;
};

declare global {
  // eslint-disable-next-line no-var
  var __TEYOLIA_WC__: WcSingletonState | undefined;
}

function devLog(message: string): void {
  if (import.meta.env.DEV) {
    console.debug(message);
  }
}

function getSingletonState(): WcSingletonState {
  if (!globalThis.__TEYOLIA_WC__) {
    globalThis.__TEYOLIA_WC__ = {};
  }
  return globalThis.__TEYOLIA_WC__;
}

export function getWcCore(): Core | null {
  return getSingletonState().core ?? null;
}

export function getWeb3Wallet(): SignClient | null {
  return getSingletonState().web3wallet ?? null;
}

export async function ensureWcInitialized(): Promise<SignClient> {
  if (!PROJECT_ID) {
    throw new Error('No projectId found for WalletConnect (VITE_WC_PROJECT_ID).');
  }

  const state = getSingletonState();

  if (state.web3wallet && state.inited) {
    devLog('[WC] reuse singleton');
    return state.web3wallet;
  }

  if (state.initPromise) {
    devLog('[WC] reuse singleton');
    return state.initPromise;
  }

  devLog('[WC] init singleton');
  const iconUrl = APP_URL ? `${APP_URL}/favicon.ico` : undefined;

  state.initPromise = (async () => {
    if (!state.core) {
      state.core = new Core({ projectId: PROJECT_ID });
    }

    const client = await SignClient.init({
      projectId: PROJECT_ID,
      core: state.core,
      metadata: {
        name: APP_NAME,
        description: 'Flipstarter 2.0 WalletConnect signer',
        url: APP_URL,
        icons: iconUrl ? [iconUrl] : [],
      },
    });

    client.on('session_proposal', () => {
      devLog('[WC] proposal received');
    });

    client.on('session_request', () => {
      devLog('[WC] request received');
    });

    state.web3wallet = client;
    state.inited = true;
    return client;
  })();

  try {
    return await state.initPromise;
  } finally {
    state.initPromise = null;
  }
}
