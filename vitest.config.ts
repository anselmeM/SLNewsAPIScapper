import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    // Ingestion tests exercise mocked network retries + politeness sleeps and
    // can exceed the 5s default under parallel load — allow headroom.
    testTimeout: 15000,
  },
});
