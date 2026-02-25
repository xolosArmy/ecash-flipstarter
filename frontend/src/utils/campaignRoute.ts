import type { CampaignSummary } from '../types/campaign';

export function getCampaignRouteId(campaign: Pick<CampaignSummary, 'id' | 'slug' | 'campaignId'>): string | null {
  const rawRouteId = campaign.id ?? campaign.slug ?? campaign.campaignId ?? null;
  if (!rawRouteId) {
    return null;
  }
  const routeId = String(rawRouteId).trim();
  return routeId || null;
}
