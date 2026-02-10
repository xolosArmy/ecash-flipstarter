import { describe, expect, it } from 'vitest';
import {
  SATS_PER_XEC,
  formatXecFromSats,
  parseXecInputToSats,
  satsToXec,
  xecToSats,
} from './amount';

describe('amount utils', () => {
  it('uses 1 XEC = 100 sats', () => {
    expect(SATS_PER_XEC).toBe(100);
    expect(satsToXec(1000)).toBe(10);
    expect(xecToSats(1000)).toBe(100000);
    expect(xecToSats(0.01)).toBe(1);
  });

  it('formats XEC without trailing zeroes', () => {
    expect(formatXecFromSats(1000)).toBe('10');
    expect(formatXecFromSats(1050)).toBe('10.5');
    expect(formatXecFromSats(1099)).toBe('10.99');
  });

  it('parses XEC input to sats with max 2 decimals', () => {
    expect(parseXecInputToSats('')).toEqual({ sats: null });
    expect(parseXecInputToSats('1000')).toEqual({ sats: 100000 });
    expect(parseXecInputToSats('0.01')).toEqual({ sats: 1 });
    expect(parseXecInputToSats('0,01')).toEqual({ sats: 1 });
    expect(parseXecInputToSats('1.234')).toEqual({ sats: null, error: 'Máximo 2 decimales' });
  });
});
