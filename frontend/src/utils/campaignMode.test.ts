import { describe, expect, it } from 'vitest';
import { canUseMonetaryCampaign, isMetadataOnly, isMonetaryUiEnabled } from './campaignMode';

const legacy = { apiVersion: 'teyolia.legacy.v1', monetaryEnabled: true, capabilities: { monetary: true } };
describe('campaign capabilities fail closed', () => {
  it('requires an explicit, consistent, recognized backend contract', () => {
    for (const value of [undefined, null, {}, { monetaryEnabled: true }, { ...legacy, apiVersion: 'unknown' }, { ...legacy, recordKind: 'metadata-only' }, { ...legacy, recordKind: 'unknown' }]) {
      expect(isMonetaryUiEnabled(value)).toBe(false);
    }
    expect(isMonetaryUiEnabled(legacy)).toBe(true);
    expect(canUseMonetaryCampaign({}, undefined)).toBe(false);
    expect(canUseMonetaryCampaign({ apiVersion: 'future' }, legacy)).toBe(false);
    expect(canUseMonetaryCampaign({ recordKind: 'unknown' }, legacy)).toBe(false);
    expect(canUseMonetaryCampaign({}, legacy)).toBe(true);
  });
  it.each([
    { apiVersion: 'teyolia.metadata.v1' }, { recordKind: 'metadata-only' },
    { monetaryEnabled: false }, { capabilities: { monetary: false } },
  ])('any non-monetary signal wins even against legacy capability flags: %j', (signal) => {
    expect(isMetadataOnly(signal)).toBe(true);
    expect(canUseMonetaryCampaign({ ...legacy, ...signal }, legacy)).toBe(false);
  });
});
