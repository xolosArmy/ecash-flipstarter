import { describe, expect, it } from 'vitest';
import { extractWalletTxid } from './txid';

describe('extractWalletTxid', () => {
  it('extracts direct txid string', () => {
    expect(extractWalletTxid('A'.repeat(64))).toBe('a'.repeat(64));
  });

  it('extracts txid from object payloads', () => {
    expect(extractWalletTxid({ txid: 'B'.repeat(64) })).toBe('b'.repeat(64));
    expect(extractWalletTxid({ result: { txid: 'C'.repeat(64) } })).toBe('c'.repeat(64));
    expect(extractWalletTxid({ result: [{ payload: { txid: 'D'.repeat(64) } }] })).toBe('d'.repeat(64));
    expect(extractWalletTxid({ response: { hash: 'E'.repeat(64) } })).toBe('e'.repeat(64));
  });

  it('returns null for unsupported shapes', () => {
    expect(extractWalletTxid({ result: { hash: 'x' } })).toBeNull();
    expect(extractWalletTxid('not-a-txid')).toBeNull();
    expect(extractWalletTxid(null)).toBeNull();
  });
});
