import { describe, expect, it } from 'vitest';
import { satsToXec, xecToSats } from '../utils/ecashUnits';

describe('ecash unit helpers', () => {
  it('converts 1 XEC to 100 sats', () => {
    expect(xecToSats(1)).toBe(100n);
  });

  it('converts 12.34 XEC to 1234 sats', () => {
    expect(xecToSats(12.34)).toBe(1234n);
    expect(satsToXec(1234n)).toBe(12.34);
  });
});
