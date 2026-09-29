import {
  TEYOLIA_COVENANT_V1,
  TEYOLIA_COVENANT_V2_G,
} from '../covenants/scriptCompiler';

export const MONETARY_FLOWS_DISABLED_CODE = 'monetary-flows-temporarily-disabled';
export const UNSUPPORTED_MONETARY_CONTRACT_VERSION_CODE = 'unsupported-monetary-contract-version';
export const MONETARY_FLOWS_DISABLED_STATUS = 503;
export const UNSUPPORTED_MONETARY_CONTRACT_VERSION_STATUS = 403;

type ContractVersionRecord = {
  contractVersion?: unknown;
};

const SUPPORTED_MONETARY_CONTRACT_VERSIONS = new Set<string>([
  TEYOLIA_COVENANT_V1,
  TEYOLIA_COVENANT_V2_G,
]);

export function monetaryFlowsEnabled(): boolean {
  return process.env.TEYOLIA_MONETARY_FLOWS_ENABLED?.trim().toLowerCase() === 'true';
}

export function isMonetaryContractVersionSupported(version: unknown): boolean {
  return typeof version === 'string'
    && SUPPORTED_MONETARY_CONTRACT_VERSIONS.has(version.trim());
}

export function assertMonetaryFlowsEnabled(): void {
  if (!monetaryFlowsEnabled()) {
    throw new Error(MONETARY_FLOWS_DISABLED_CODE);
  }
}

export function assertMonetaryContractVersionSupported(
  campaign: ContractVersionRecord | null | undefined,
): void {
  if (!isMonetaryContractVersionSupported(campaign?.contractVersion)) {
    throw new Error(UNSUPPORTED_MONETARY_CONTRACT_VERSION_CODE);
  }
}

export function assertMonetaryOperationAllowed(
  campaign: ContractVersionRecord | null | undefined,
): void {
  assertMonetaryFlowsEnabled();
  assertMonetaryContractVersionSupported(campaign);
}

export function isMonetaryFlowsDisabledError(error: unknown): boolean {
  return error instanceof Error && error.message === MONETARY_FLOWS_DISABLED_CODE;
}

export function isUnsupportedMonetaryContractVersionError(error: unknown): boolean {
  return error instanceof Error && error.message === UNSUPPORTED_MONETARY_CONTRACT_VERSION_CODE;
}

export function monetaryFlowsDisabledBody() {
  return {
    error: MONETARY_FLOWS_DISABLED_CODE,
    code: MONETARY_FLOWS_DISABLED_CODE,
  };
}

export function unsupportedMonetaryContractVersionBody() {
  return {
    error: UNSUPPORTED_MONETARY_CONTRACT_VERSION_CODE,
    code: UNSUPPORTED_MONETARY_CONTRACT_VERSION_CODE,
  };
}
