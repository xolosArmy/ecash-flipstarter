import { describe, expect, it } from 'vitest';
import { resolveEscrowAddress, validateEscrowConsistency } from '../services/escrowAddress';

describe('escrow resolver', () => {
  it('prefers escrowAddress when present', () => {
    expect(resolveEscrowAddress({
      id: 'a',
      escrowAddress: 'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
      covenantAddress: 'ecash:qp4d6w53w4g5x7m9fkxya7nc4r4j8rj7ss9j5zrvw8',
    })).toBe('ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a');
  });

  it('falls back to covenantAddress', () => {
    expect(resolveEscrowAddress({
      id: 'a',
      covenantAddress: 'ecash:qp4d6w53w4g5x7m9fkxya7nc4r4j8rj7ss9j5zrvw8',
    })).toBe('ecash:qp4d6w53w4g5x7m9fkxya7nc4r4j8rj7ss9j5zrvw8');
  });

  it('returns mismatch error when stored escrow and covenant diverge', () => {
    const result = validateEscrowConsistency({
      id: 'a',
      escrowAddress: 'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
      covenantAddress: 'ecash:qp4d6w53w4g5x7m9fkxya7nc4r4j8rj7ss9j5zrvw8',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('escrow-address-mismatch');
      expect(result.details.expectedEscrow).toBe('ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a');
    }
  });
});
