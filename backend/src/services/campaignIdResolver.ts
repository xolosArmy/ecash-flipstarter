import type { StoredCampaign } from '../db/SQLiteStore';

const CAMPAIGN_SLUG_PATTERN = /^campaign-(\d{10,})$/;

/**
 * Fixtures with canonical public URLs that have historically mapped to legacy internal IDs.
 * Keep this list short and deterministic for backwards compatibility.
 */
export const CAMPAIGN_URL_FIXTURE_MAP: Record<string, string> = {
  'https://www.teyolia.cash/campaigns/campaign-1771354603513': 'pledge-repair-1771265990458-26507',
};

const FIXTURE_SLUG_TO_ID = Object.fromEntries(
  Object.entries(CAMPAIGN_URL_FIXTURE_MAP)
    .map(([url, campaignId]) => {
      try {
        const parsed = new URL(url);
        const slug = parsed.pathname.split('/').filter(Boolean).pop();
        if (!slug) return null;
        return [slug, campaignId] as const;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry)),
);

export function deriveCampaignSlug(snapshot: Pick<StoredCampaign, 'id' | 'createdAt'> & { slug?: string }): string {
  const explicitSlug = typeof snapshot.slug === 'string' ? snapshot.slug.trim() : '';
  if (explicitSlug) {
    return explicitSlug;
  }
  const parsedCreatedAt = Date.parse(snapshot.createdAt);
  if (Number.isFinite(parsedCreatedAt) && parsedCreatedAt > 0) {
    return `campaign-${Math.floor(parsedCreatedAt)}`;
  }

  const idMatch = snapshot.id.match(/(\d{10,})/);
  if (idMatch) {
    return `campaign-${idMatch[1]}`;
  }
  return `campaign-${snapshot.id}`;
}

export function resolveCampaignIdFromSnapshots(input: string, snapshots: StoredCampaign[]): string | null {
  const candidate = String(input ?? '').trim();
  if (!candidate) return null;

  const direct = snapshots.find((snapshot) => snapshot.id === candidate);
  if (direct) return direct.id;

  const fixtureCampaignId = FIXTURE_SLUG_TO_ID[candidate];
  if (fixtureCampaignId && snapshots.some((snapshot) => snapshot.id === fixtureCampaignId)) {
    return fixtureCampaignId;
  }

  const byExplicitSlug = snapshots.find((snapshot) => typeof snapshot.slug === 'string' && snapshot.slug === candidate);
  if (byExplicitSlug) return byExplicitSlug.id;

  if (!CAMPAIGN_SLUG_PATTERN.test(candidate)) {
    return null;
  }

  const byDerivedSlug = snapshots.find((snapshot) => deriveCampaignSlug(snapshot) === candidate);
  if (byDerivedSlug) return byDerivedSlug.id;

  const slugTs = Number(candidate.slice('campaign-'.length));
  if (!Number.isFinite(slugTs)) {
    return null;
  }

  const byNearestCreatedAt = snapshots
    .map((snapshot) => {
      const createdAtTs = Date.parse(snapshot.createdAt);
      if (!Number.isFinite(createdAtTs)) return null;
      return {
        id: snapshot.id,
        delta: Math.abs(createdAtTs - slugTs),
      };
    })
    .filter((entry): entry is { id: string; delta: number } => Boolean(entry))
    .sort((a, b) => a.delta - b.delta)[0];

  if (byNearestCreatedAt && byNearestCreatedAt.delta <= 60_000) {
    return byNearestCreatedAt.id;
  }

  return null;
}
