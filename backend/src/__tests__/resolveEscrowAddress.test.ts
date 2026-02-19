import { describe, expect, it } from 'vitest';
import { resolveEscrowAddress, validateEscrowConsistency } from '../services/escrowAddress';

const ESCROW = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk';
const OTHER = 'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';

describe('resolveEscrowAddress', () => {
  it('prioritizes escrowAddress', () => {
    expect(resolveEscrowAddress({ id: 'camp-1', escrowAddress: ESCROW, covenantAddress: OTHER })).toBe(ESCROW);
  });

  it('falls back to covenantAddress', () => {
    expect(resolveEscrowAddress({ id: 'camp-2', covenantAddress: ESCROW })).toBe(ESCROW);
  });

  it('falls back to legacy campaignAddress/recipientAddress', () => {
    expect(resolveEscrowAddress({ id: 'camp-3', campaignAddress: ESCROW })).toBe(ESCROW);
  });

  it('returns mismatch details when alternate fields diverge from canonical escrow', () => {
    const mismatch = validateEscrowConsistency({ id: 'camp-4', escrowAddress: ESCROW, campaignAddress: OTHER });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.details.canonicalEscrow).toBe(ESCROW);
      expect(mismatch.details.campaignAddress).toBe(OTHER);
    }
  });
});
