import type { CampaignMode } from '../types/metadata';

/** Any explicit non-monetary signal wins, including a partially mixed legacy response. */
export function isMetadataOnly(campaign: CampaignMode | null | undefined): boolean {
  return Boolean(campaign && (
    campaign.apiVersion === 'teyolia.metadata.v1'
    || campaign.recordKind === 'metadata-only'
    || campaign.monetaryEnabled === false
    || campaign.capabilities?.monetary === false
  ));
}

/** Unknown, unavailable and inconsistent backend capabilities always fail closed. */
export function isMonetaryUiEnabled(capabilities: CampaignMode | null | undefined): boolean {
  return Boolean(capabilities
    && capabilities.apiVersion === 'teyolia.legacy.v1'
    && capabilities.monetaryEnabled === true
    && capabilities.capabilities?.monetary === true
    && !capabilities.recordKind
    && !isMetadataOnly(capabilities));
}

export function canUseMonetaryCampaign(
  campaign: CampaignMode | null | undefined,
  capabilities: CampaignMode | null | undefined,
): boolean {
  return Boolean(campaign && isMonetaryUiEnabled(capabilities)
    && (!campaign.apiVersion || campaign.apiVersion === 'teyolia.legacy.v1')
    && !campaign.recordKind
    && !isMetadataOnly(campaign));
}
