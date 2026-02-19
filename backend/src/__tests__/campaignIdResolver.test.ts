import { describe, expect, it } from 'vitest';
import { resolveCampaignIdFromSnapshots } from '../services/campaignIdResolver';
import type { StoredCampaign } from '../db/SQLiteStore';

const snapshots: StoredCampaign[] = [
  {
    id: 'pledge-repair-1771265990458-26507',
    slug: 'campaign-1771354603513',
    name: 'Legacy active campaign',
    goal: '1000',
    expiresAt: '2026-02-19T18:19:50.458Z',
    createdAt: '2026-02-16T18:19:50.475Z',
    status: 'active',
  },
];

describe('resolveCampaignIdFromSnapshots', () => {
  it('resolves public campaign slug to canonical legacy id', () => {
    expect(resolveCampaignIdFromSnapshots('campaign-1771354603513', snapshots)).toBe(
      'pledge-repair-1771265990458-26507',
    );
  });

  it('returns canonical id when id is provided', () => {
    expect(resolveCampaignIdFromSnapshots('pledge-repair-1771265990458-26507', snapshots)).toBe(
      'pledge-repair-1771265990458-26507',
    );
  });

  it('returns null for unknown id/slug', () => {
    expect(resolveCampaignIdFromSnapshots('campaign-0000000000000', snapshots)).toBeNull();
  });
});
