import logger from '../logger.js';

/**
 * Boot-time environment validation.
 *
 * The server, the ingestion worker and the combined entrypoint all need the same
 * fail-fast checks: a missing DATABASE_URL or a production deployment without
 * API credentials otherwise only surfaces as per-request 500s (or a crash deep
 * inside an ingestion run) long after the platform reported the deploy healthy.
 * Every check here is pure and runs before any socket is opened; `assertRuntimeEnv`
 * turns the result into log lines + a non-zero exit in real processes.
 */

export interface EnvValidationResult {
  errors: string[];
  warnings: string[];
}

export interface RuntimeEnvValidationOptions {
  /**
   * Whether production must have a usable credential source (API_KEY or Clerk).
   * The scrape-only worker never serves HTTP, so it passes `false`.
   */
  requireApiCredentials?: boolean;
}

const VALID_NODE_ENVS = ['development', 'test', 'production'] as const;

interface NumericEnvRule {
  name: string;
  /** Smallest accepted value; 0 allows "disabled"/"no proxy" settings. */
  min: number;
}

/**
 * Numeric variables that fall back to a default when unparseable. Kept as a
 * single table so the warning list cannot drift from the values the app reads.
 */
const NUMERIC_ENV_RULES: readonly NumericEnvRule[] = [
  { name: 'RATE_LIMIT_MAX', min: 1 },
  { name: 'RATE_LIMIT_WINDOW_MS', min: 1 },
  { name: 'TRUST_PROXY_HOPS', min: 0 },
  { name: 'API_KEY_CACHE_TTL_MS', min: 1 },
  { name: 'DOCS_RATE_LIMIT_MAX', min: 1 },
  { name: 'VIDEO_SYNC_COOLDOWN_MS', min: 0 },
  { name: 'INGESTION_DEADLINE_MS', min: 1 },
  { name: 'FRESHNESS_MAX_AGE_MS', min: 1 },
];

/** Minimal logger surface for `assertRuntimeEnv` (pino-compatible, injectable). */
export interface EnvValidationLogger {
  warn(context: unknown, message: string): void;
  fatal(context: unknown, message: string): void;
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

/**
 * Validate the runtime environment without throwing, logging or exiting.
 *
 * Errors are conditions that make the process unusable (no database, unusable
 * port, unknown NODE_ENV, production without any credential source). Warnings
 * are configuration mistakes that still fall back to a safe default.
 */
export function validateRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: RuntimeEnvValidationOptions = {},
): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const requireApiCredentials = options.requireApiCredentials ?? true;
  const nodeEnv = env.NODE_ENV?.trim() ?? '';

  if (isBlank(env.DATABASE_URL)) {
    errors.push('DATABASE_URL is required: the API and ingestion pipelines cannot reach Postgres without it.');
  }

  if (nodeEnv !== '' && !VALID_NODE_ENVS.some((value) => value === nodeEnv)) {
    errors.push(`NODE_ENV must be one of ${VALID_NODE_ENVS.join(', ')} (got "${nodeEnv}").`);
  }

  // Only an explicit production deployment fails fast on missing credentials:
  // other environments may legitimately run without auth (health checks, local
  // poking), and the request-time auth middleware already fails closed with 500.
  if (nodeEnv === 'production' && requireApiCredentials && isBlank(env.API_KEY) && isBlank(env.CLERK_SECRET_KEY)) {
    errors.push(
      'API_KEY or CLERK_SECRET_KEY is required in production: every data route would fail closed with 500 on every request.',
    );
  }

  if (!isBlank(env.PORT)) {
    const port = Number(env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(`PORT must be an integer between 1 and 65535 (got "${env.PORT}").`);
    }
  }

  for (const rule of NUMERIC_ENV_RULES) {
    const raw = env[rule.name];
    if (isBlank(raw)) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < rule.min) {
      const expectation = rule.min === 0 ? 'a non-negative integer' : 'a positive integer';
      warnings.push(`${rule.name} must be ${expectation} (got "${raw}"); the built-in default will be used.`);
    }
  }

  // Keep `resolveCorsOrigin` as the single source of the origin value, but emit
  // the wildcard warning here so all boot warnings share one log path/format.
  if (nodeEnv === 'production' && isBlank(env.CORS_ORIGIN)) {
    warnings.push(
      'CORS_ORIGIN is not set: allowing every browser origin (*) in production. Set CORS_ORIGIN to restrict cross-origin access.',
    );
  }

  return { errors, warnings };
}

export interface AssertRuntimeEnvOptions extends RuntimeEnvValidationOptions {
  env?: NodeJS.ProcessEnv;
  logger?: EnvValidationLogger;
  exit?: (code: number) => void;
}

let hasValidatedRuntimeEnv = false;

/** Test hook: allow `assertRuntimeEnv` to run again in the same process. */
export function resetRuntimeEnvValidation(): void {
  hasValidatedRuntimeEnv = false;
}

/** Whether `assertRuntimeEnv` already ran in this process (diagnostics/tests). */
export function runtimeEnvHasBeenValidated(): boolean {
  return hasValidatedRuntimeEnv;
}

const FAILURE_HINT = 'Invalid runtime environment: fix the variables above and restart the process.';

/**
 * Validate, log and (on errors) exit — for boot paths only.
 *
 * No-ops under NODE_ENV=test: test workers import modules instead of booting a
 * process, and must never inherit a developer machine's missing env. The first
 * non-test call wins (index.ts validates before it imports server.ts), so the
 * warnings/errors are logged once rather than per entrypoint.
 */
export function assertRuntimeEnv(options: AssertRuntimeEnvOptions = {}): boolean {
  const env = options.env ?? process.env;
  if ((env.NODE_ENV ?? '').trim() === 'test') return true;
  if (hasValidatedRuntimeEnv) return true;
  hasValidatedRuntimeEnv = true;

  const { errors, warnings } = validateRuntimeEnv(env, { requireApiCredentials: options.requireApiCredentials });
  const log = options.logger ?? logger;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  if (warnings.length > 0) {
    log.warn({ warnings }, 'Runtime environment warnings (built-in defaults are used for invalid values).');
  }

  if (errors.length > 0) {
    log.fatal({ errors }, FAILURE_HINT);
    exit(1);
    return false;
  }

  return true;
}
