import { describe, expect, it } from 'vitest';
import { normalizeOutpoints } from './outpoints';

describe('normalizeOutpoints', () => {
  it('maps txid/vout objects to txid:vout', () => {
    const txid = 'a'.repeat(64);
    expect(normalizeOutpoints([{ txid, vout: 1 }])).toEqual([`${txid}:1`]);
  });

  it('rejects invalid txid', () => {
    expect(() => normalizeOutpoints([{ txid: 'abc', vout: 0 }])).toThrow('txid inválido');
  });

  it('rejects invalid vout', () => {
    const txid = 'b'.repeat(64);
    expect(() => normalizeOutpoints([{ txid, vout: Number.NaN }])).toThrow('vout inválido');
  });
});
