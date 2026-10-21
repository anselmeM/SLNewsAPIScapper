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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // Process wiring / CLI entrypoints are exercised by the integration suite
      // or by hand, not by the unit suite; keep the threshold focused on logic.
      exclude: ['src/__tests__/**', 'src/index.ts', 'src/scrape.ts', 'src/scripts/**'],
      // Measured on this suite (2026-10-21): 91.73% stmts / 86.37% branches /
      // 94.23% funcs / 92.89% lines. Thresholds sit a few points below so CI is
      // stable but regressions still fail the build.
      thresholds: {
        lines: 90,
        statements: 89,
        functions: 92,
        branches: 83,
      },
    },
  },
});
