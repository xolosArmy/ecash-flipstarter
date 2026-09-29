import { LEGACY_PLACEHOLDER_COVENANT } from '../covenants/scriptCompiler';
import { assertMonetaryContractVersionSupported } from './monetaryContractPolicy';

export const LEGACY_PLACEHOLDER_DISABLED_CODE = 'legacy_placeholder_disabled';
export const LEGACY_PLACEHOLDER_DISABLED_STATUS = 403;

type ContractVersionRecord = {
  contractVersion?: unknown;
};

export function isLegacyPlaceholderCampaign(
  campaign: ContractVersionRecord | null | undefined,
): boolean {
  return campaign?.contractVersion === LEGACY_PLACEHOLDER_COVENANT;
}

export function assertLegacyPlaceholderMonetaryOperationsAllowed(
  campaign: ContractVersionRecord | null | undefined,
): void {
  if (isLegacyPlaceholderCampaign(campaign)) {
    throw new Error(LEGACY_PLACEHOLDER_DISABLED_CODE);
  }
  assertMonetaryContractVersionSupported(campaign);
}

export function legacyPlaceholderDisabledBody() {
  return {
    error: LEGACY_PLACEHOLDER_DISABLED_CODE,
    code: LEGACY_PLACEHOLDER_DISABLED_CODE,
  };
}

export function isLegacyPlaceholderDisabledError(error: unknown): boolean {
  return error instanceof Error && error.message === LEGACY_PLACEHOLDER_DISABLED_CODE;
}
