import { describe, expect, it } from 'vitest';
import { shouldStopActivationPolling } from './activationPolling';

describe('shouldStopActivationPolling', () => {
  it('stops on active', () => {
    expect(shouldStopActivationPolling({ status: 'active' } as any)).toBe(true);
  });

  it('stops on invalid states', () => {
    expect(
      shouldStopActivationPolling({ status: 'pending_verification', verificationStatus: 'invalid' } as any),
    ).toBe(true);
    expect(
      shouldStopActivationPolling({
        status: 'pending_verification',
        activationFeeVerificationStatus: 'invalid',
      } as any),
    ).toBe(true);
    expect(shouldStopActivationPolling({ status: 'pending_fee' } as any)).toBe(true);
  });

  it('continues while pending verification', () => {
    expect(
      shouldStopActivationPolling({
        status: 'pending_verification',
        verificationStatus: 'pending_verification',
      } as any),
    ).toBe(false);
  });
});
