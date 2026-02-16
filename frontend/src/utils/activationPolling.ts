import type { CampaignActivationStatusResponse } from '../api/client';

export function shouldStopActivationPolling(status: CampaignActivationStatusResponse): boolean {
  if (status.status === 'active') return true;
  if (status.status === 'pending_fee' || status.status === 'fee_invalid') return true;
  return status.verificationStatus === 'invalid' || status.activationFeeVerificationStatus === 'invalid';
}
