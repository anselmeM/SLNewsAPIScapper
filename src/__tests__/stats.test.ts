import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '../db.js';

vi.mock('../db.js', () => ({
  prisma: {
    article: {
      count: vi.fn().mockResolvedValue(100),
      groupBy: vi.fn().mockResolvedValue([
        { source: 'The Sierra Leone Telegraph', _count: { source: 70 } },
        { source: 'Politico SL', _count: { source: 30 } },
      ]),
      findFirst: vi.fn().mockResolvedValue({
        pubDate: new Date('2026-09-05T12:00:00Z'),
        createdAt: new Date('2026-09-05T12:05:00Z'),
      }),
    },
    video: {
      count: vi.fn().mockResolvedValue(25),
      groupBy: vi.fn().mockResolvedValue([
        { channelTitle: 'AYV News Sierra Leone', _count: { channelTitle: 15 } },
        { channelTitle: 'SLBC National TV', _count: { channelTitle: 10 } },
      ]),
      findFirst: vi.fn().mockResolvedValue({
        publishedAt: new Date('2026-09-05T14:00:00Z'),
        createdAt: new Date('2026-09-05T14:02:00Z'),
      }),
    },
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

const originalApiKey = process.env.API_KEY;
const originalNodeEnv = process.env.NODE_ENV;
process.env.API_KEY = 'test-key-123';
process.env.NODE_ENV = 'test';

let app: ReturnType<typeof request>;

beforeAll(async () => {
  const { default: expressApp } = await import('../server.js');
  app = request(expressApp as unknown as Express);
});

afterAll(() => {
  process.env.API_KEY = originalApiKey;
  process.env.NODE_ENV = originalNodeEnv;
});

describe('GET /api/stats', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.get('/api/stats');
    expect(res.status).toBe(401);
  });

  it('returns aggregated metrics across articles and videos', async () => {
    const res = await app.get('/api/stats').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.articles.total).toBe(100);
    expect(res.body.articles.by_source['The Sierra Leone Telegraph']).toBe(70);
    expect(res.body.articles.by_source['Politico SL']).toBe(30);
    expect(res.body.videos.total).toBe(25);
    expect(res.body.videos.by_channel['AYV News Sierra Leone']).toBe(15);
    expect(res.body.timestamp).toBeDefined();
  });
});

describe('GET /v1/stats', () => {
  it('accepts valid API key on /v1/stats alias', async () => {
    const res = await app.get('/v1/stats').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.body.articles.total).toBe(100);
  });
});
