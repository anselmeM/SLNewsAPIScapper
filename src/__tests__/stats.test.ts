import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '../db.js';

vi.mock('../db.js', () => ({
  prisma: {
    article: {
      count: vi.fn(),
      groupBy: vi.fn(),
      findFirst: vi.fn(),
    },
    video: {
      count: vi.fn(),
      groupBy: vi.fn(),
      findFirst: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

const articleCount = prisma.article.count as ReturnType<typeof vi.fn>;
const articleGroupBy = prisma.article.groupBy as ReturnType<typeof vi.fn>;
const articleFindFirst = prisma.article.findFirst as ReturnType<typeof vi.fn>;
const videoCount = prisma.video.count as ReturnType<typeof vi.fn>;
const videoGroupBy = prisma.video.groupBy as ReturnType<typeof vi.fn>;
const videoFindFirst = prisma.video.findFirst as ReturnType<typeof vi.fn>;

const originalApiKey = process.env.API_KEY;
const originalNodeEnv = process.env.NODE_ENV;
const originalFreshnessMaxAge = process.env.FRESHNESS_MAX_AGE_MS;
process.env.API_KEY = 'test-key-123';
process.env.NODE_ENV = 'test';
delete process.env.FRESHNESS_MAX_AGE_MS;

const AUTH = { Authorization: 'Bearer test-key-123' };
const HOUR_MS = 60 * 60 * 1000;

let articleIngestedAt: Date;
let videoIngestedAt: Date;
let app: ReturnType<typeof request>;

beforeAll(async () => {
  const { default: expressApp } = await import('../server.js');
  app = request(expressApp as unknown as Express);
});

beforeEach(() => {
  vi.clearAllMocks();

  articleIngestedAt = new Date(Date.now() - 60_000);
  videoIngestedAt = new Date(Date.now() - 120_000);

  articleCount
    .mockReset()
    .mockImplementation((args?: { where?: { pubDateSource?: string; contentSource?: unknown } }) => {
      // Three article counts: total, missing_date, empty_content.
      if (args?.where?.pubDateSource === 'missing') return Promise.resolve(7);
      if (args?.where?.contentSource) return Promise.resolve(3);
      return Promise.resolve(100);
    });
  articleGroupBy.mockResolvedValue([
    { source: 'The Sierra Leone Telegraph', _count: { source: 70 } },
    { source: 'Politico SL', _count: { source: 30 } },
  ]);
  articleFindFirst.mockResolvedValue({
    pubDate: new Date('2026-09-05T12:00:00Z'),
    createdAt: articleIngestedAt,
  });

  videoCount.mockReset().mockImplementation((args?: { where?: { publishedAtSource?: string } }) => {
    // Two video counts: total, missing_date.
    if (args?.where?.publishedAtSource === 'missing') return Promise.resolve(2);
    return Promise.resolve(25);
  });
  videoGroupBy.mockResolvedValue([
    { channelTitle: 'AYV News Sierra Leone', _count: { channelTitle: 15 } },
    { channelTitle: 'SLBC National TV', _count: { channelTitle: 10 } },
  ]);
  videoFindFirst.mockResolvedValue({
    publishedAt: new Date('2026-09-05T14:00:00Z'),
    createdAt: videoIngestedAt,
  });
});

afterAll(() => {
  process.env.API_KEY = originalApiKey;
  process.env.NODE_ENV = originalNodeEnv;
  if (originalFreshnessMaxAge === undefined) delete process.env.FRESHNESS_MAX_AGE_MS;
  else process.env.FRESHNESS_MAX_AGE_MS = originalFreshnessMaxAge;
});

describe('GET /api/stats', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.get('/api/stats');
    expect(res.status).toBe(401);
  });

  it('returns aggregated metrics across articles and videos', async () => {
    const res = await app.get('/api/stats').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.articles.total).toBe(100);
    expect(res.body.articles.by_source['The Sierra Leone Telegraph']).toBe(70);
    expect(res.body.articles.by_source['Politico SL']).toBe(30);
    expect(res.body.videos.total).toBe(25);
    expect(res.body.videos.by_channel['AYV News Sierra Leone']).toBe(15);
    expect(res.body.timestamp).toBeDefined();
    // Provenance/quarantine counters for operators.
    expect(res.body.articles.missing_date).toBe(7);
    expect(res.body.articles.empty_content).toBe(3);
    expect(res.body.videos.missing_date).toBe(2);
    expect(articleCount).toHaveBeenCalledWith({ where: { pubDateSource: 'missing' } });
    expect(articleCount).toHaveBeenCalledWith({ where: { contentSource: { in: ['empty', 'summary'] } } });
    expect(videoCount).toHaveBeenCalledWith({ where: { publishedAtSource: 'missing' } });
    // Existing fields are preserved alongside the new sections.
    expect(res.body.articles.latest_ingested_at).toBe(articleIngestedAt.toISOString());
    expect(res.body.videos.latest_ingested_at).toBe(videoIngestedAt.toISOString());
  });

  it('adds runtime metrics', async () => {
    const res = await app.get('/api/stats').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.runtime).toMatchObject({
      uptime_seconds: expect.any(Number),
      process_started_at: expect.any(String),
      memory_rss_mb: expect.any(Number),
      node_version: process.version,
      requests_total: expect.any(Number),
    });
    expect(Number.isNaN(Date.parse(res.body.runtime.process_started_at))).toBe(false);
    expect(res.body.runtime.requests_by_status).toEqual({
      '2xx': expect.any(Number),
      '3xx': expect.any(Number),
      '4xx': expect.any(Number),
      '5xx': expect.any(Number),
    });
  });

  it('reports recent ingestions as fresh', async () => {
    const res = await app.get('/api/stats').set(AUTH);
    expect(res.status).toBe(200);

    expect(res.body.freshness.articles).toEqual({
      latest_ingested_at: articleIngestedAt.toISOString(),
      lag_seconds: expect.any(Number),
      stale: false,
    });
    expect(res.body.freshness.articles.lag_seconds).toBeGreaterThanOrEqual(60);
    expect(res.body.freshness.videos.stale).toBe(false);
  });

  it('flags a stale article feed when the latest ingestion exceeds FRESHNESS_MAX_AGE_MS', async () => {
    const oldIngestedAt = new Date(Date.now() - 3 * HOUR_MS);
    articleFindFirst.mockResolvedValueOnce({ pubDate: new Date('2026-09-05T12:00:00Z'), createdAt: oldIngestedAt });

    const res = await app.get('/api/stats').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.freshness.articles.latest_ingested_at).toBe(oldIngestedAt.toISOString());
    expect(res.body.freshness.articles.lag_seconds).toBeGreaterThan(7200);
    expect(res.body.freshness.articles.stale).toBe(true);
    // The other feed is still fresh.
    expect(res.body.freshness.videos.stale).toBe(false);
  });

  it('reports empty feeds as stale with a null lag (no data is not healthy)', async () => {
    articleFindFirst.mockResolvedValueOnce(null);
    videoFindFirst.mockResolvedValueOnce(null);

    const res = await app.get('/api/stats').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.articles.latest_ingested_at).toBeNull();
    expect(res.body.freshness).toEqual({
      articles: { latest_ingested_at: null, lag_seconds: null, stale: true },
      videos: { latest_ingested_at: null, lag_seconds: null, stale: true },
    });
  });

  it('honours the FRESHNESS_MAX_AGE_MS environment override', async () => {
    process.env.FRESHNESS_MAX_AGE_MS = '60000';
    try {
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      articleFindFirst.mockResolvedValueOnce({ pubDate: new Date('2026-09-05T12:00:00Z'), createdAt: twoMinutesAgo });

      const res = await app.get('/api/stats').set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body.freshness.articles.stale).toBe(true);
    } finally {
      delete process.env.FRESHNESS_MAX_AGE_MS;
    }
  });
});

describe('GET /v1/stats', () => {
  it('accepts valid API key on /v1/stats alias', async () => {
    const res = await app.get('/v1/stats').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.articles.total).toBe(100);
    expect(res.body.runtime).toBeDefined();
    expect(res.body.freshness).toBeDefined();
  });
});
