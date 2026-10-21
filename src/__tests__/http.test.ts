import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import logger from '../logger.js';
import {
  sleep,
  fetchWithRetry,
  parseRetryAfterMs,
  computeRetryDelayMs,
  RETRY_DELAY_MS,
  MAX_RETRY_AFTER_MS,
  MAX_BACKOFF_MS,
} from '../utils/http.js';

vi.mock('axios');
vi.mock('../logger.js', () => ({
  default: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

describe('http utilities', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.mocked(axios.get).mockReset();
  });

  describe('sleep', () => {
    it('resolves immediately in test environment', async () => {
      const start = Date.now();
      await sleep(1000);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('parseRetryAfterMs', () => {
    const now = Date.UTC(2026, 9, 21, 12, 0, 0);

    it('parses delta-seconds', () => {
      expect(parseRetryAfterMs('5', now)).toBe(5000);
    });

    it('caps delta-seconds at MAX_RETRY_AFTER_MS', () => {
      expect(parseRetryAfterMs('3600', now)).toBe(MAX_RETRY_AFTER_MS);
    });

    it('parses an HTTP-date relative to now', () => {
      const delay = parseRetryAfterMs(new Date(now + 12_000).toUTCString(), now);
      expect(delay).toBeGreaterThanOrEqual(11_000);
      expect(delay).toBeLessThanOrEqual(12_000);
    });

    it('caps an HTTP-date at MAX_RETRY_AFTER_MS', () => {
      expect(parseRetryAfterMs(new Date(now + 3_600_000).toUTCString(), now)).toBe(MAX_RETRY_AFTER_MS);
    });

    it('returns 0 for missing, invalid, zero or already-expired values', () => {
      expect(parseRetryAfterMs(undefined, now)).toBe(0);
      expect(parseRetryAfterMs(null, now)).toBe(0);
      expect(parseRetryAfterMs('', now)).toBe(0);
      expect(parseRetryAfterMs('0', now)).toBe(0);
      expect(parseRetryAfterMs('soon', now)).toBe(0);
      expect(parseRetryAfterMs(new Date(now - 1000).toUTCString(), now)).toBe(0);
    });

    it('accepts an array header value', () => {
      expect(parseRetryAfterMs(['7'], now)).toBe(7000);
    });
  });

  describe('computeRetryDelayMs', () => {
    it('uses exponential backoff with zero injected jitter', () => {
      expect(computeRetryDelayMs(1, undefined, () => 0)).toBe(RETRY_DELAY_MS);
      expect(computeRetryDelayMs(2, undefined, () => 0)).toBe(RETRY_DELAY_MS * 2);
      expect(computeRetryDelayMs(3, undefined, () => 0)).toBe(RETRY_DELAY_MS * 4);
    });

    it('adds bounded jitter', () => {
      expect(computeRetryDelayMs(2, undefined, () => 1)).toBe(RETRY_DELAY_MS * 2 * 1.25);

      const defaultDelay = computeRetryDelayMs(2);
      expect(defaultDelay).toBeGreaterThanOrEqual(RETRY_DELAY_MS * 2);
      expect(defaultDelay).toBeLessThanOrEqual(RETRY_DELAY_MS * 2 * 1.25);

      // Backoff is clamped so a large retry count cannot sleep for minutes.
      expect(computeRetryDelayMs(20, undefined, () => 1)).toBeLessThanOrEqual(MAX_BACKOFF_MS * 1.25);
    });

    it('honours a server Retry-After value and clamps it', () => {
      expect(computeRetryDelayMs(1, 7000, () => 0)).toBe(7000);
      expect(computeRetryDelayMs(1, 3_600_000, () => 0)).toBe(MAX_RETRY_AFTER_MS);
    });
  });

  describe('fetchWithRetry', () => {
    it('returns response on successful GET', async () => {
      const mockResponse = { data: 'ok', status: 200 };
      vi.mocked(axios.get).mockResolvedValueOnce(mockResponse as never);

      const res = await fetchWithRetry('https://example.com');
      expect(res).toBe(mockResponse);
      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('retries on 500 server error and succeeds', async () => {
      const serverError = { response: { status: 500 } };
      const successResponse = { data: 'recovered', status: 200 };
      vi.mocked(axios.get)
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce(successResponse as never);

      const res = await fetchWithRetry('https://example.com', {}, 3);
      expect(res).toBe(successResponse);
      expect(axios.get).toHaveBeenCalledTimes(2);
    });

    it('does not retry on 404 client error', async () => {
      const notFoundError = { response: { status: 404 } };
      vi.mocked(axios.get).mockRejectedValueOnce(notFoundError);

      await expect(fetchWithRetry('https://example.com', {}, 3)).rejects.toEqual(notFoundError);
      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('throws last error when all retries are exhausted', async () => {
      const networkError = new Error('Connection refused');
      vi.mocked(axios.get).mockRejectedValue(networkError);

      await expect(fetchWithRetry('https://example.com', {}, 2)).rejects.toThrow('Connection refused');
      expect(axios.get).toHaveBeenCalledTimes(2);
    });

    it('honours Retry-After on 429 instead of exponential backoff', async () => {
      const rateLimited = { response: { status: 429, headers: { 'retry-after': '2' } } };
      vi.mocked(axios.get)
        .mockRejectedValueOnce(rateLimited)
        .mockResolvedValueOnce({ data: 'ok', status: 200 } as never);

      const res = await fetchWithRetry('https://example.com', {}, 3);

      expect(res).toMatchObject({ data: 'ok' });
      expect(axios.get).toHaveBeenCalledTimes(2);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ retryAfterMs: 2000, delayMs: 2000 }),
        'HTTP request failed; retrying',
      );
    });

    it('honours an HTTP-date Retry-After on 503', async () => {
      const now = Date.now();
      const serviceUnavailable = {
        response: { status: 503, headers: { 'retry-after': new Date(now + 5000).toUTCString() } },
      };
      vi.mocked(axios.get)
        .mockRejectedValueOnce(serviceUnavailable)
        .mockResolvedValueOnce({ data: 'ok', status: 200 } as never);

      await fetchWithRetry('https://example.com', {}, 3);

      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ retryAfterMs: expect.any(Number) }),
        'HTTP request failed; retrying',
      );
    });

    it('does not start an attempt when the deadline has already passed', async () => {
      await expect(fetchWithRetry('https://example.com', {}, { deadlineMs: Date.now() - 1000 })).rejects.toMatchObject({
        code: 'DEADLINE_EXCEEDED',
      });
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('caps each attempt timeout to the remaining deadline', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      vi.mocked(axios.get).mockResolvedValueOnce({ data: 'ok', status: 200 } as never);

      await fetchWithRetry('https://example.com', { timeout: 8000 }, { deadlineMs: 1_002_000 });

      expect(axios.get).toHaveBeenCalledWith('https://example.com', expect.objectContaining({ timeout: 2000 }));
    });

    it('keeps the configured timeout when it is below the remaining deadline', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      vi.mocked(axios.get).mockResolvedValueOnce({ data: 'ok', status: 200 } as never);

      await fetchWithRetry('https://example.com', { timeout: 500 }, { deadlineMs: 1_010_000 });

      expect(axios.get).toHaveBeenCalledWith('https://example.com', expect.objectContaining({ timeout: 500 }));
    });

    it('stops retrying instead of sleeping past the deadline', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const networkError = new Error('Connection refused');
      vi.mocked(axios.get).mockRejectedValue(networkError);

      await expect(
        fetchWithRetry('https://example.com', { timeout: 5000 }, { retries: 5, deadlineMs: 1_000_500 }),
      ).rejects.toThrow('Connection refused');

      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(axios.get).toHaveBeenCalledWith('https://example.com', expect.objectContaining({ timeout: 500 }));
    });
  });
});
