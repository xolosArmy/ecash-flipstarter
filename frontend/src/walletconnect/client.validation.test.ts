import { describe, expect, it } from 'vitest';
import {
  getEcashAccounts,
  getPreferredEcashChain,
  isEcashSessionValid,
} from './client';

describe('walletconnect ecash session validation', () => {
  it('accepts ecash:1 + long method', () => {
    const session = {
      namespaces: {
        ecash: {
          chains: ['ecash:1'],
          methods: ['ecash_signAndBroadcastTransaction'],
          accounts: ['ecash:1:ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'],
        },
      },
    } as any;

    expect(isEcashSessionValid(session)).toBe(true);
  });

  it('accepts ecash:mainnet + alias method', () => {
    const session = {
      namespaces: {
        ecash: {
          chains: ['ecash:mainnet'],
          methods: ['ecash_signAndBroadcast'],
          accounts: ['ecash:mainnet:ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'],
        },
      },
    } as any;

    expect(isEcashSessionValid(session)).toBe(true);
  });

  it('accepts missing chains when accounts include ecash chain', () => {
    const session = {
      namespaces: {
        ecash: {
          methods: ['ecash_signAndBroadcast'],
          accounts: ['ecash:1:ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'],
        },
      },
    } as any;

    expect(isEcashSessionValid(session)).toBe(true);
    expect(getPreferredEcashChain(session)).toBe('ecash:1');
  });

  it('prefers ecash:1 address over ecash:mainnet when both exist', () => {
    const mainnetAddress = 'ecash:qq07examplemainnet';
    const chain1Address = 'ecash:qq07examplechain1';
    const session = {
      namespaces: {
        ecash: {
          methods: ['ecash_signAndBroadcast'],
          accounts: [
            `ecash:mainnet:${mainnetAddress}`,
            `ecash:1:${chain1Address}`,
          ],
        },
      },
    } as any;

    expect(getEcashAccounts(session)).toEqual([chain1Address, mainnetAddress]);
  });

  it('rejects sessions without accepted signing methods', () => {
    const session = {
      namespaces: {
        ecash: {
          chains: ['ecash:1'],
          methods: ['ecash_getAddresses'],
          accounts: ['ecash:1:ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'],
        },
      },
    } as any;

    expect(isEcashSessionValid(session)).toBe(false);
  });
});
