import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      NODE_ENV: 'test',
    },
    include: ['src/__tests__/**/*.test.ts'],
    // Unit tests stay database-free: the real-Postgres suite lives under
    // src/__tests__/integration and runs only through
    // `npm run test:integration` (vitest.integration.config.mts).
    exclude: ['**/node_modules/**', '**/dist/**', 'src/__tests__/integration/**'],
    // Ingestion tests exercise mocked network retries + politeness sleeps and
    // can exceed the 5s default under parallel load — allow headroom.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
