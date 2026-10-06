import { describe, expect, it, vi } from 'vitest';
import {
  MISSING_TONALLI_PUBKEY_MESSAGE,
  SIMULATED_ECASH_PUBKEY,
  extractSessionEcashPublicKey,
  readDisclosedEcashPublicKey,
  resolveTonalliBeneficiaryPubKey,
} from './ecashPublicKey';

const REAL_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

describe('extractSessionEcashPublicKey', () => {
  it('reads publicKey from the ecash session properties', () => {
    expect(extractSessionEcashPublicKey({
      sessionProperties: { publicKey: REAL_PUBKEY.toUpperCase() },
      namespaces: { ecash: { accounts: ['ecash:1:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'] } },
    })).toBe(REAL_PUBKEY);
  });

  it('reads pubkey from an ecash account object', () => {
    expect(extractSessionEcashPublicKey({
      namespaces: {
        ecash: {
          accounts: [{ address: 'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', pubkey: REAL_PUBKEY }],
        },
      },
    })).toBe(REAL_PUBKEY);
  });

  it('rejects the simulated key and ignores the WalletConnect peer key', () => {
    expect(extractSessionEcashPublicKey({
      peer: { publicKey: REAL_PUBKEY },
      sessionProperties: { publicKey: SIMULATED_ECASH_PUBKEY },
      namespaces: { ecash: { accounts: ['ecash:1:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'] } },
    })).toBeNull();
    expect(extractSessionEcashPublicKey({
      peer: { publicKey: REAL_PUBKEY },
      namespaces: { ecash: { accounts: ['ecash:1:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'] } },
    })).toBeNull();
  });
});

describe('readDisclosedEcashPublicKey', () => {
  it('accepts publicKey or pubkey when the address belongs to the session', () => {
    expect(readDisclosedEcashPublicKey({
      publicKey: REAL_PUBKEY,
      address: 'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
    }, ['qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'])).toEqual({
      publicKey: REAL_PUBKEY,
      addressMatches: true,
    });

    expect(readDisclosedEcashPublicKey({
      pubkey: REAL_PUBKEY,
      address: 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
    }, ['ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a']).publicKey).toBe(REAL_PUBKEY);
  });

  it('rejects a disclosed key for a different account', () => {
    expect(readDisclosedEcashPublicKey({
      pubkey: REAL_PUBKEY,
      address: 'ecash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    }, ['ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'])).toEqual({
      publicKey: REAL_PUBKEY,
      addressMatches: false,
    });
  });
});

describe('resolveTonalliBeneficiaryPubKey', () => {
  it('uses the key already exposed by the session', async () => {
    const requestAccountPublicKey = vi.fn();
    const connect = vi.fn();
    const resetSession = vi.fn();

    await expect(resolveTonalliBeneficiaryPubKey({
      publicKey: REAL_PUBKEY,
      connect,
      resetSession,
      requestAccountPublicKey,
    })).resolves.toBe(REAL_PUBKEY);

    expect(requestAccountPublicKey).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(resetSession).not.toHaveBeenCalled();
  });

  it('asks Tonalli again when the current session has no key', async () => {
    const requestAccountPublicKey = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(REAL_PUBKEY);
    const connect = vi.fn().mockResolvedValue({ topic: 'reconnected' });
    const resetSession = vi.fn().mockResolvedValue(undefined);

    await expect(resolveTonalliBeneficiaryPubKey({
      publicKey: SIMULATED_ECASH_PUBKEY,
      connect,
      resetSession,
      requestAccountPublicKey,
    })).resolves.toBe(REAL_PUBKEY);

    expect(resetSession).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('blocks submission when reconnection still does not yield a key', async () => {
    await expect(resolveTonalliBeneficiaryPubKey({
      publicKey: null,
      connect: vi.fn().mockResolvedValue(null),
      resetSession: vi.fn().mockResolvedValue(undefined),
      requestAccountPublicKey: vi.fn().mockResolvedValue(null),
    })).rejects.toThrow(MISSING_TONALLI_PUBKEY_MESSAGE);
  });

  it('does not reconnect when the user rejects the Tonalli request', async () => {
    const connect = vi.fn();
    const resetSession = vi.fn();

    await expect(resolveTonalliBeneficiaryPubKey({
      publicKey: null,
      connect,
      resetSession,
      requestAccountPublicKey: vi.fn().mockRejectedValue(new Error('Solicitud rechazada por el usuario.')),
    })).rejects.toThrow('Solicitud rechazada por el usuario.');

    expect(connect).not.toHaveBeenCalled();
    expect(resetSession).not.toHaveBeenCalled();
  });
});
