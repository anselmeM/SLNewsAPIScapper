import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import logger from '../logger.js';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export const RETRY_DELAY_MS = 1000;
export const MAX_RETRIES = 3;

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
 * GET request with exponential backoff (1s, 2s, 4s). Transient network errors,
 * 5xx and 429 (rate limit) are retried; other 4xx responses are not — e.g. a
 * 404 from a numbered sitemap page is how we detect the end of the sitemap.
 */
export async function fetchWithRetry(
  url: string,
  options: AxiosRequestConfig = {},
  retries = MAX_RETRIES,
): Promise<AxiosResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, options);
    } catch (err) {
      lastError = err;
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status !== undefined && status < 500 && status !== 429) throw err;
      if (attempt < retries) {
        const delayMs = process.env.NODE_ENV === 'test' ? 0 : RETRY_DELAY_MS * 2 ** (attempt - 1);
        logger.warn({ url, attempt, err }, 'HTTP request failed; retrying');
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}
