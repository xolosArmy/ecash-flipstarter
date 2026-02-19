import { describe, expect, it } from 'vitest';
import { resolveEscrowAddress, validateEscrowConsistency } from '../services/escrowAddress';

const ESCROW = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk';
const OTHER = 'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';

describe('escrow resolver', () => {
  it('prefers escrowAddress when present', () => {
    expect(resolveEscrowAddress({ id: 'a', escrowAddress: ESCROW, covenantAddress: OTHER })).toBe(ESCROW);
  });

  it('falls back to covenantAddress', () => {
    expect(resolveEscrowAddress({ id: 'a', covenantAddress: ESCROW })).toBe(ESCROW);
  });

  it('returns mismatch error when stored escrow and campaignAddress diverge', () => {
    const result = validateEscrowConsistency({ id: 'a', escrowAddress: ESCROW, campaignAddress: OTHER });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('escrow-address-mismatch');
      expect(result.details.canonicalEscrow).toBe(ESCROW);
    }
  });
});
