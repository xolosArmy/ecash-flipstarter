import { describe, expect, it } from 'vitest';
import { resolveCampaignPublicRouteId } from './CreateCampaignWizard';

describe('resolveCampaignPublicRouteId', () => {
  it('prefers slug for public navigation urls', () => {
    expect(resolveCampaignPublicRouteId({
      id: 'canonical-id-1',
      slug: 'campaign-1777777777777',
    })).toBe('campaign-1777777777777');
  });

  it('falls back to id when slug/publicId are missing', () => {
    expect(resolveCampaignPublicRouteId({
      id: 'canonical-id-2',
    })).toBe('canonical-id-2');
  });
});
