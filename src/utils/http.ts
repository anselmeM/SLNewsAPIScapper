import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import logger from '../logger.js';
import { assertSafeFetchUrl, isUnsafeFetchError } from './safe-url.js';
import { fetchFollowingSafeRedirects, isOkOrRedirectStatus, safeHttpAgent, safeHttpsAgent } from './safe-fetch.js';

// A browser-like UA is the compatibility default. Set SCRAPER_USER_AGENT to a
// descriptive bot identifier without changing any of the scraping behaviour.
export const USER_AGENT =
  process.env.SCRAPER_USER_AGENT ??
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export const RETRY_DELAY_MS = 1000;
export const MAX_RETRIES = 3;
/** Retry-After values above this are clamped so one header cannot stall a run. */
export const MAX_RETRY_AFTER_MS = 30_000;
/** Upper bound for a single exponential backoff step (before jitter). */
export const MAX_BACKOFF_MS = 30_000;
/** Jitter is a fraction of the backoff step, so retries do not synchronize. */
export const JITTER_RATIO = 0.25;

export interface RetryOptions {
  /** Total attempts (the first request plus retries). Defaults to MAX_RETRIES. */
  retries?: number;
  /**
   * Absolute epoch-millisecond deadline for this request. Once reached, no new
   * attempt starts; each attempt's axios timeout is also capped to the time left.
   */
  deadlineMs?: number;
}

/**
 * Resolves after `ms` milliseconds. Automatically resolves immediately in test
 * environments to prevent artificial test execution delays.
 */
export async function sleep(ms: number): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    return;
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds,
 * clamped to MAX_RETRY_AFTER_MS. Returns 0 for absent, expired or unparseable
 * values so callers can fall back to exponential backoff.
 */
export function parseRetryAfterMs(value: unknown, now: number = Date.now()): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null) return 0;

  const text = String(raw).trim();
  if (!text) return 0;

  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  // HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT"). Date.parse is lenient,
  // which is fine: unparseable values become NaN and fall back to 0.
  const timestamp = Date.parse(text);
  if (Number.isNaN(timestamp)) return 0;

  const deltaMs = timestamp - now;
  if (deltaMs <= 0) return 0;
  return Math.min(deltaMs, MAX_RETRY_AFTER_MS);
}

/**
 * Delay before the next attempt. Uses the server's Retry-After when present,
 * otherwise exponential backoff (1s, 2s, 4s...) plus bounded jitter. `random`
 * can be injected for deterministic tests.
 */
export function computeRetryDelayMs(
  attempt: number,
  retryAfterMs: number | undefined = undefined,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  }

  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(RETRY_DELAY_MS * 2 ** exponent, MAX_BACKOFF_MS);
  const jitter = base * JITTER_RATIO * Math.min(Math.max(random(), 0), 1);
  return Math.round(base + jitter);
}

function deadlineExceededError(url: string, deadlineMs: number): Error {
  const error = new Error(`Request deadline exceeded for ${url} (deadline ${deadlineMs})`) as Error & { code: string };
  error.code = 'DEADLINE_EXCEEDED';
  return error;
}

function getRetryAfterHeader(err: unknown): unknown {
  const headers = (err as { response?: { headers?: unknown } }).response?.headers;
  if (!headers || typeof headers !== 'object') return undefined;

  const record = headers as Record<string, unknown> & { get?: (name: string) => unknown };
  if (typeof record.get === 'function') return record.get('retry-after');
  return record['retry-after'] ?? record['Retry-After'];
}

/**
 * GET with retries. Transient network errors, 5xx and 429 (rate limit) are
 * retried; other 4xx are not — e.g. a 404 from a numbered sitemap page is how
 * we detect the end of the sitemap. 429/503 honour Retry-After. When an absolute
 * deadline is supplied the request stops retrying once it is reached instead of
 * sleeping past it.
 */
export async function fetchWithRetry(
  url: string,
  options: AxiosRequestConfig = {},
  retryOptions: number | RetryOptions = MAX_RETRIES,
): Promise<AxiosResponse> {
  // Feed-controlled URLs must not reach internal addresses (sync guard: blocks
  // loopback/private literals and local hostnames before any network I/O).
  assertSafeFetchUrl(url);
  const { retries, deadlineMs } =
    typeof retryOptions === 'number' ? { retries: retryOptions, deadlineMs: undefined } : retryOptions;
  const maxAttempts = Math.max(1, Math.floor(retries ?? MAX_RETRIES));

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remainingMs = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      if (lastError !== undefined) break;
      throw deadlineExceededError(url, deadlineMs as number);
    }

    let attemptOptions: AxiosRequestConfig = {
      ...options,
      // Pin every connection to the DNS answer that was validated by the
      // agent's lookup callback. Caller-supplied agents are intentionally not
      // used for this boundary.
      httpAgent: safeHttpAgent,
      httpsAgent: safeHttpsAgent,
      // Ambient HTTP(S)_PROXY/ALL_PROXY variables must not be honoured: axios
      // would send the request to the proxy, which resolves the feed-controlled
      // hostname itself and bypasses the lookup above (SSRF via proxy). Direct,
      // validated egress is the only supported path here.
      proxy: false,
      // Redirects are followed manually so every Location is validated before
      // the next request; the safe redirect helper owns the 5-hop limit.
      maxRedirects: 0,
      validateStatus: isOkOrRedirectStatus,
    };
    if (remainingMs !== undefined) {
      const configuredTimeout = attemptOptions.timeout;
      const cappedTimeout = configuredTimeout === undefined ? remainingMs : Math.min(configuredTimeout, remainingMs);
      attemptOptions = { ...attemptOptions, timeout: Math.max(1, cappedTimeout) };
    }

    try {
      return await fetchFollowingSafeRedirects(url, (target) => axios.get(target, attemptOptions));
    } catch (err) {
      lastError = err;
      if (isUnsafeFetchError(err)) throw err;
      const status = (err as { response?: { status?: number } }).response?.status;
      // Unknown status means a transport-level error (DNS, timeout, reset).
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable) throw err;

      if (attempt >= maxAttempts) break;

      const retryAfterMs = status === 429 || status === 503 ? parseRetryAfterMs(getRetryAfterHeader(err)) : 0;
      const delayMs = computeRetryDelayMs(attempt, retryAfterMs);

      if (deadlineMs !== undefined) {
        const timeLeftMs = deadlineMs - Date.now();
        if (delayMs >= timeLeftMs) {
          logger.warn(
            { url, attempt, status, delayMs, timeLeftMs },
            'HTTP deadline reached; not retrying so the run is not stalled',
          );
          break;
        }
      }

      logger.warn({ url, attempt, status, delayMs, retryAfterMs }, 'HTTP request failed; retrying');
      await sleep(delayMs);
    }
  }

  throw lastError;
}
