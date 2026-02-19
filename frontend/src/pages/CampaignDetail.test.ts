import { describe, expect, it } from 'vitest';
import { resolveMutationCampaignId } from './CampaignDetail';

describe('resolveMutationCampaignId', () => {
  it('uses canonical id for mutations when slug differs from canonical id', () => {
    const result = resolveMutationCampaignId(
      'campaign-1771354603513',
      'pledge-repair-1771265990458-26507',
      { id: 'pledge-repair-1771265990458-26507' },
    );

    expect(result).toEqual({ ok: true, canonicalId: 'pledge-repair-1771265990458-26507' });
  });

  it('blocks mutations on payload mismatch', () => {
    const result = resolveMutationCampaignId(
      'campaign-1771354603513',
      'pledge-repair-1771265990458-26507',
      { id: 'campaign-1771354603513' },
    );

    expect(result.ok).toBe(false);
  });
});
