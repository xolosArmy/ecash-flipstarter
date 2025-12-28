import { describe, expect, it } from 'vitest';
import { resolveTonalliBridgeBaseUrl } from './tonalliBridge';

describe('resolveTonalliBridgeBaseUrl', () => {
  it('overrides prod bridge in local dev', () => {
    const baseUrl = resolveTonalliBridgeBaseUrl({
      env: { VITE_TONALLI_BRIDGE_URL: 'https://cartera.xolosarmy.xyz' },
      hostname: 'localhost',
    });

    expect(baseUrl).toBe('http://127.0.0.1:5174');
  });

  it('keeps env value in production', () => {
    const baseUrl = resolveTonalliBridgeBaseUrl({
      env: { VITE_TONALLI_BRIDGE_URL: 'https://cartera.xolosarmy.xyz' },
      hostname: 'flipstarter.example',
    });

    expect(baseUrl).toBe('https://cartera.xolosarmy.xyz');
  });

  it('normalizes trailing slash', () => {
    const baseUrl = resolveTonalliBridgeBaseUrl({
      env: { VITE_TONALLI_BASE_URL: 'https://wallet.example/' },
      hostname: 'wallet.example',
    });

    expect(baseUrl).toBe('https://wallet.example');
  });
});
