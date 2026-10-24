import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '.vite-cache',
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    cache: false,
    // Existing monetary unit/integration tests opt in explicitly. Production
    // remains fail-closed because the runtime parser defaults to false.
    env: {
      TEYOLIA_MONETARY_FLOWS_ENABLED: 'true',
    },
  },
});
