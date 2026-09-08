import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { sleep, fetchWithRetry } from '../utils/http.js';

vi.mock('axios');
vi.mock('../logger.js', () => ({
  default: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe('http utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sleep', () => {
    it('resolves immediately in test environment', async () => {
      const start = Date.now();
      await sleep(1000);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
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
  });
});
