import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assertRuntimeEnv,
  resetRuntimeEnvValidation,
  runtimeEnvHasBeenValidated,
  validateRuntimeEnv,
} from '../config/env.js';

function validProductionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/sl_news',
    NODE_ENV: 'production',
    API_KEY: 'test-key',
    PORT: '3000',
    CORS_ORIGIN: 'https://pwa.example.com',
    ...overrides,
  };
}

function createFakeLogger() {
  return {
    warn: vi.fn(),
    fatal: vi.fn(),
  };
}

describe('validateRuntimeEnv', () => {
  it('accepts a complete production environment', () => {
    expect(validateRuntimeEnv(validProductionEnv())).toEqual({ errors: [], warnings: [] });
  });

  it('errors when DATABASE_URL is missing or blank', () => {
    for (const value of [undefined, '', '   ']) {
      const result = validateRuntimeEnv(validProductionEnv({ DATABASE_URL: value }));
      expect(result.errors).toEqual([expect.stringContaining('DATABASE_URL')]);
      expect(result.warnings).toEqual([]);
    }
  });

  it('errors when production has neither API_KEY nor CLERK_SECRET_KEY', () => {
    const result = validateRuntimeEnv(validProductionEnv({ API_KEY: undefined, CLERK_SECRET_KEY: undefined }));

    expect(result.errors).toEqual([expect.stringContaining('API_KEY or CLERK_SECRET_KEY')]);
    expect(result.warnings).toEqual([]);
  });

  it('does not require credentials when requireApiCredentials is false (scrape worker)', () => {
    const env = validProductionEnv({ API_KEY: undefined, CLERK_SECRET_KEY: undefined });

    const result = validateRuntimeEnv(env, { requireApiCredentials: false });

    expect(result.errors).toEqual([]);
  });

  it('accepts a Clerk secret key as the production credential source', () => {
    const result = validateRuntimeEnv(validProductionEnv({ API_KEY: undefined, CLERK_SECRET_KEY: 'sk_test_clerk' }));

    expect(result.errors).toEqual([]);
  });

  it('errors on an unknown NODE_ENV', () => {
    const result = validateRuntimeEnv(validProductionEnv({ NODE_ENV: 'staging' }));

    expect(result.errors).toEqual([expect.stringContaining('NODE_ENV')]);
  });

  it('errors on a PORT outside 1..65535', () => {
    for (const PORT of ['0', '65536', 'not-a-number', '80.5', '-1']) {
      const result = validateRuntimeEnv(validProductionEnv({ PORT }));
      expect(result.errors).toEqual([expect.stringContaining('PORT')]);
    }
  });

  it('accepts valid and unset PORT values', () => {
    expect(validateRuntimeEnv(validProductionEnv({ PORT: '1' })).errors).toEqual([]);
    expect(validateRuntimeEnv(validProductionEnv({ PORT: '65535' })).errors).toEqual([]);
    expect(validateRuntimeEnv(validProductionEnv({ PORT: undefined })).errors).toEqual([]);
  });

  it('warns about invalid numeric tunables instead of failing boot', () => {
    const result = validateRuntimeEnv(
      validProductionEnv({
        RATE_LIMIT_MAX: 'lots',
        RATE_LIMIT_WINDOW_MS: '15m',
        API_KEY_CACHE_TTL_MS: '30s',
        DOCS_RATE_LIMIT_MAX: 'many',
        INGESTION_DEADLINE_MS: '45m',
        FRESHNESS_MAX_AGE_MS: '2h',
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(6);
    for (const name of [
      'RATE_LIMIT_MAX',
      'RATE_LIMIT_WINDOW_MS',
      'API_KEY_CACHE_TTL_MS',
      'DOCS_RATE_LIMIT_MAX',
      'INGESTION_DEADLINE_MS',
      'FRESHNESS_MAX_AGE_MS',
    ]) {
      expect(result.warnings.some((warning) => warning.includes(name))).toBe(true);
    }
  });

  it('accepts zero for tunables where zero means disabled/no proxy', () => {
    const result = validateRuntimeEnv(validProductionEnv({ TRUST_PROXY_HOPS: '0', VIDEO_SYNC_COOLDOWN_MS: '0' }));

    expect(result.warnings).toEqual([]);
  });

  it('warns about negative tunables that must be non-negative', () => {
    const result = validateRuntimeEnv(validProductionEnv({ TRUST_PROXY_HOPS: '-1' }));

    expect(result.warnings).toEqual([expect.stringContaining('TRUST_PROXY_HOPS')]);
  });

  it('warns about the wildcard CORS fallback in production', () => {
    const result = validateRuntimeEnv(validProductionEnv({ CORS_ORIGIN: undefined }));

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('CORS_ORIGIN')]);
  });

  it('does not warn about CORS outside production', () => {
    const result = validateRuntimeEnv(validProductionEnv({ NODE_ENV: 'development', CORS_ORIGIN: undefined }));

    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it('reports every independent error at once', () => {
    const result = validateRuntimeEnv({ NODE_ENV: 'staging', PORT: 'abc' });

    expect(result.errors).toHaveLength(3); // DATABASE_URL + NODE_ENV + PORT
    expect(result.errors.join(' ')).toContain('DATABASE_URL');
    expect(result.errors.join(' ')).toContain('NODE_ENV');
    expect(result.errors.join(' ')).toContain('PORT');
  });
});

describe('assertRuntimeEnv', () => {
  beforeEach(() => {
    resetRuntimeEnvValidation();
    vi.clearAllMocks();
  });

  it('no-ops under NODE_ENV=test (module imports in test workers must never exit)', () => {
    const logger = createFakeLogger();
    const exit = vi.fn();

    const result = assertRuntimeEnv({ env: { NODE_ENV: 'test' }, logger, exit });

    expect(result).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(runtimeEnvHasBeenValidated()).toBe(false);
  });

  it('passes without logging when the environment is valid', () => {
    const logger = createFakeLogger();
    const exit = vi.fn();

    const result = assertRuntimeEnv({ env: validProductionEnv(), logger, exit });

    expect(result).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(runtimeEnvHasBeenValidated()).toBe(true);
  });

  it('logs warnings and continues when only warnings are present', () => {
    const logger = createFakeLogger();
    const exit = vi.fn();

    const result = assertRuntimeEnv({ env: validProductionEnv({ RATE_LIMIT_MAX: 'abc' }), logger, exit });

    expect(result).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { warnings: [expect.stringContaining('RATE_LIMIT_MAX')] },
      expect.any(String),
    );
    expect(logger.fatal).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('logs errors fatally and exits 1', () => {
    const logger = createFakeLogger();
    const exit = vi.fn();

    const result = assertRuntimeEnv({ env: validProductionEnv({ DATABASE_URL: undefined }), logger, exit });

    expect(result).toBe(false);
    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(logger.fatal).toHaveBeenCalledWith(
      { errors: [expect.stringContaining('DATABASE_URL')] },
      expect.stringContaining('Invalid runtime environment'),
    );
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('only validates once per process (entrypoints do not re-log)', () => {
    const logger = createFakeLogger();
    const exit = vi.fn();
    const env = validProductionEnv({ RATE_LIMIT_MAX: 'abc' });

    expect(assertRuntimeEnv({ env, logger, exit })).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    expect(assertRuntimeEnv({ env, logger, exit })).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();

    resetRuntimeEnvValidation();
    expect(assertRuntimeEnv({ env, logger, exit })).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('supports the scrape-only mode (database required, auth credentials optional)', () => {
    const logger = createFakeLogger();
    const exit = vi.fn();

    const result = assertRuntimeEnv({
      env: validProductionEnv({ API_KEY: undefined, CLERK_SECRET_KEY: undefined }),
      logger,
      exit,
      requireApiCredentials: false,
    });

    expect(result).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });
});
