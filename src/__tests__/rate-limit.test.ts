import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '../db.js';

// Must be set before the server module is imported: src/server.ts reads the rate
// limit configuration once, when the limiter is constructed. Two requests per
// client keeps the test fast.
const originalRateLimitMax = process.env.RATE_LIMIT_MAX;
const originalRateLimitWindowMs = process.env.RATE_LIMIT_WINDOW_MS;
const originalApiKey = process.env.API_KEY;
const originalNodeEnv = process.env.NODE_ENV;

const TEST_RATE_LIMIT_MAX = '2';
process.env.RATE_LIMIT_MAX = TEST_RATE_LIMIT_MAX;
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key-123';

vi.mock('../db.js', () => ({
  prisma: {
    article: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
    },
    video: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// TEST-NET-3 addresses: documentation-only ranges, one per simulated client.
const CLIENT_A = '203.0.113.10';
const CLIENT_B = '203.0.113.20';

let app: ReturnType<typeof request>;

beforeAll(async () => {
  const { default: expressApp } = await import('../server.js');
  app = request(expressApp as unknown as Express);
});

afterAll(() => {
  restoreEnv('RATE_LIMIT_MAX', originalRateLimitMax);
  restoreEnv('RATE_LIMIT_WINDOW_MS', originalRateLimitWindowMs);
  restoreEnv('API_KEY', originalApiKey);
  restoreEnv('NODE_ENV', originalNodeEnv);
});

describe('rate limiting behind the proxy', () => {
  it('gives each X-Forwarded-For client a separate budget and 429s the third request', async () => {
    // Unauthenticated requests fall back to the IP key, so the two clients must
    // not share the budget the limiter derives from req.ip.
    const firstA = await app.get('/api/news').set('X-Forwarded-For', CLIENT_A);
    const secondA = await app.get('/api/news').set('X-Forwarded-For', CLIENT_A);
    const firstB = await app.get('/api/news').set('X-Forwarded-For', CLIENT_B);

    // The limiter runs before authentication, so these are 401 (not 429) and
    // each client's limit is the configured 2 rather than the default 100.
    expect(firstA.status).toBe(401);
    expect(secondA.status).toBe(401);
    expect(firstB.status).toBe(401);
    expect(firstA.headers['ratelimit-limit']).toBe(TEST_RATE_LIMIT_MAX);
    expect(firstB.headers['ratelimit-limit']).toBe(TEST_RATE_LIMIT_MAX);

    // Client A is now over budget...
    const thirdA = await app.get('/api/news').set('X-Forwarded-For', CLIENT_A);
    expect(thirdA.status).toBe(429);
    expect(thirdA.body.error).toContain('Too many requests');
    expect(thirdA.headers['retry-after']).toBeDefined();

    // ...while client B still has its own independent budget left.
    const secondB = await app.get('/api/news').set('X-Forwarded-For', CLIENT_B);
    expect(secondB.status).toBe(401);
  });

  it('never throttles the health endpoint', async () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ '?column?': 1 }]);

    const res = await app.get('/api/health').set('X-Forwarded-For', CLIENT_A);

    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBeUndefined();
  });
});
