import { defineConfig } from 'vitest/config';

/**
 * Real-Postgres integration suite (P2-9).
 *
 * Runs only the tests under `src/__tests__/integration/` against a disposable
 * PostgreSQL database (`DATABASE_URL`, migrations applied with
 * `npx prisma migrate deploy`). The unit suite (`npm test`) uses
 * `vitest.config.mts`, which excludes this directory and stays DB-free.
 *
 * Execution is serial in a single fork so the per-test table truncation in
 * `beforeEach` cannot race another test file.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      NODE_ENV: 'test',
    },
    include: ['src/__tests__/integration/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Serial execution in a single fork: the suite truncates tables in
    // `beforeEach`, so concurrent test files would race each other.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    sequence: {
      concurrent: false,
    },
  },
});
