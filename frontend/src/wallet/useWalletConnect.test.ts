import { describe, expect, it } from 'vitest';
import { normalizeWalletConnectOutputs } from './useWalletConnect';

describe('normalizeWalletConnectOutputs', () => {
  it('serializes final WalletConnect payload with protocol and amount', () => {
    expect(
      normalizeWalletConnectOutputs([
        {
          address: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
          valueSats: 546n,
          token: {
            protocol: 'ALP',
            tokenId: 'c923bd0f09c630c5e9980cf518c8d34b6353802a3cb7c3f34fa7cc85c9305908',
            amount: '160000',
          },
        },
      ]),
    ).toEqual([
      {
        address: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
        valueSats: '546',
        token: {
          protocol: 'ALP',
          tokenId: 'c923bd0f09c630c5e9980cf518c8d34b6353802a3cb7c3f34fa7cc85c9305908',
          amount: '160000',
        },
      },
    ]);
  });

  it('upgrades legacy tokenAmount payloads and does not emit tokenAmount', () => {
    const normalized = normalizeWalletConnectOutputs([
      {
        address: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
        valueSats: 546,
        token: {
          tokenId: 'c923bd0f09c630c5e9980cf518c8d34b6353802a3cb7c3f34fa7cc85c9305908',
          tokenAmount: '160000',
        },
      },
    ]);

    expect(normalized[0]).toEqual({
      address: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
      valueSats: '546',
      token: {
        protocol: 'ALP',
        tokenId: 'c923bd0f09c630c5e9980cf518c8d34b6353802a3cb7c3f34fa7cc85c9305908',
        amount: '160000',
      },
    });
    expect('tokenAmount' in (normalized[0].token as Record<string, unknown>)).toBe(false);
  });
});
