import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '../db.js';

vi.mock('../db.js', () => ({
  prisma: {
    article: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
    },
    video: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

const mockArticles = [
  {
    id: 1,
    title: 'Test Article',
    link: 'https://example.com/article-1',
    author: 'Test Author',
    description: 'A test article description',
    category: ['Politics'],
    imageUrl: null,
    paragraphs: ['First paragraph', 'Second paragraph'],
    pubDate: new Date('2025-01-01'),
    source: 'Politico SL',
    createdAt: new Date('2025-01-01'),
  },
];

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

describe('GET /api/health', () => {
  it('returns 200 with ok status when DB is connected', async () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ '?column?': 1 }]);

    const res = await app.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('connected');
    expect(res.body.timestamp).toBeDefined();
  });

  it('returns 503 when DB is disconnected', async () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Connection failed'));

    const res = await app.get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.database).toBe('disconnected');
  });
});

describe('GET /', () => {
  it('returns API info with endpoints', async () => {
    const res = await app.get('/');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Sierra Leone News API');
    expect(res.body.endpoints.news).toBeDefined();
    expect(res.body.endpoints.health).toBeDefined();
  });
});

describe('GET /api/news', () => {
  it('returns 401 without API key', async () => {
    const res = await app.get('/api/news').set('Authorization', '');
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Unauthorized');
  });

  it('returns articles with valid API key', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(mockArticles);

    const res = await app.get('/api/news').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('Test Article');
  });

  it('accepts a lowercase bearer scheme', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(mockArticles);

    const res = await app.get('/api/news').set('Authorization', 'bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('passes pagination params to the query', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(mockArticles);

    const res = await app.get('/api/news?limit=10&page=2').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10, skip: 10, orderBy: [{ pubDate: 'desc' }, { id: 'desc' }] }),
    );
  });

  it('reports the total article count via X-Total-Count', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(mockArticles);

    const res = await app.get('/api/news').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.headers['x-total-count']).toBe('1');
  });

  it('sets cache headers on the list response', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(mockArticles);

    const res = await app.get('/api/news').set('Authorization', 'Bearer test-key-123');
    expect(res.headers['cache-control']).toContain('public');
  });

  it('returns 400 for invalid limit', async () => {
    const res = await app.get('/api/news?limit=0').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('limit');
  });

  it('returns 400 for fractional limit', async () => {
    const res = await app.get('/api/news?limit=1.5').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('limit');
  });

  it('returns 400 for invalid page', async () => {
    const res = await app.get('/api/news?page=0').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('page');
  });

  it('returns 400 for invalid source', async () => {
    const res = await app.get('/api/news?source=InvalidSource').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid source');
  });

  it('filters articles by search query q', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(mockArticles);

    const res = await app.get('/api/news?q=politics').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { title: { contains: 'politics', mode: 'insensitive' } },
            { description: { contains: 'politics', mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });

  it('returns 400 when search query q exceeds 100 characters', async () => {
    const longQuery = 'a'.repeat(101);
    const res = await app.get(`/api/news?q=${longQuery}`).set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('100 characters');
  });
});

describe('GET /api/news/:id', () => {
  it('returns 400 for non-numeric id', async () => {
    const res = await app.get('/api/news/abc').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('id');
  });

  it('returns 400 for fractional id', async () => {
    const res = await app.get('/api/news/1.5').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('id');
  });

  it('returns 404 for missing article', async () => {
    const mockFindUnique = prisma.article.findUnique as ReturnType<typeof vi.fn>;
    mockFindUnique.mockResolvedValueOnce(null);

    const res = await app.get('/api/news/999').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(404);
  });

  it('returns article by id', async () => {
    const mockFindUnique = prisma.article.findUnique as ReturnType<typeof vi.fn>;
    mockFindUnique.mockResolvedValueOnce(mockArticles[0]);

    const res = await app.get('/api/news/1').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Test Article');
  });

  it('sets cache headers on the article response', async () => {
    const mockFindUnique = prisma.article.findUnique as ReturnType<typeof vi.fn>;
    mockFindUnique.mockResolvedValueOnce(mockArticles[0]);

    const res = await app.get('/api/news/1').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('public');
  });
});

describe('Unknown routes', () => {
  it('returns a JSON 404 for unknown API paths', async () => {
    const res = await app.get('/api/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
    expect(res.headers['content-type']).toContain('application/json');
  });
});

describe('Versioned API v1', () => {
  // The db mock bypasses Prisma's select, so strip paragraphs to emulate what
  // the metadata-only select returns.
  const metaOnlyArticles = mockArticles.map(({ paragraphs: _paragraphs, ...rest }) => rest);

  it('returns the contract envelope { data, meta } with a valid key', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(metaOnlyArticles);

    const res = await app.get('/v1/news').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toEqual({
      id: 1,
      title: 'Test Article',
      summary: 'A test article description',
      source: 'Politico SL',
      category: ['Politics'],
      url: 'https://example.com/article-1',
      published_at: '2025-01-01T00:00:00.000Z',
    });
    expect(res.body.meta).toEqual({ page: 1, page_size: 20, total: 1, has_more: false });
  });

  it('never exposes full article text (link + summary model)', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(metaOnlyArticles);

    const res = await app.get('/v1/news').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.body.data[0].paragraphs).toBeUndefined();
    // and the DB query itself must not request paragraphs
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.not.objectContaining({ paragraphs: true }) }),
    );
  });

  it('requires an API key', async () => {
    const res = await app.get('/v1/news');
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Unauthorized');
  });

  it('passes pagination params and reports has_more', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(mockArticles);

    const res = await app.get('/v1/news?page_size=10&page=2').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10, skip: 10, orderBy: [{ pubDate: 'desc' }, { id: 'desc' }] }),
    );
    expect(res.body.meta).toEqual({ page: 2, page_size: 10, total: 1, has_more: false });
  });

  it('accepts limit as an alias for page_size', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(mockArticles);

    const res = await app.get('/v1/news?limit=5').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.body.meta.page_size).toBe(5);
  });

  it('returns 400 for invalid page_size', async () => {
    const res = await app.get('/v1/news?page_size=0').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('page_size');
  });

  it('returns 400 for page_size above the max', async () => {
    const res = await app.get('/v1/news?page_size=101').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('page_size');
  });

  it('returns 400 for invalid page', async () => {
    const res = await app.get('/v1/news?page=1.5').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('page');
  });

  it('returns 400 for an invalid source', async () => {
    const res = await app.get('/v1/news?source=Unknown').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('source');
  });

  it('filters by category (repeated params and comma-separated)', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(mockArticles);

    const res = await app
      .get('/v1/news?category=politics&category=economy')
      .set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ category: { hasSome: ['politics', 'economy'] } }) }),
    );
  });

  it('filters by published date window', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(mockArticles);

    const res = await app.get('/v1/news?from=2026-08-01&to=2026-08-07').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          pubDate: { gte: new Date('2026-08-01'), lte: new Date('2026-08-07T23:59:59.999Z') },
        }),
      }),
    );
  });

  it('returns 400 for a page beyond the cap', async () => {
    const res = await app.get('/v1/news?page=10001').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('page');
  });

  it('returns 400 for an invalid date range', async () => {
    const res = await app.get('/v1/news?from=not-a-date').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('from');
  });

  it('returns 400 when from is after to', async () => {
    const res = await app.get('/v1/news?from=2026-08-07&to=2026-08-01').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('from');
  });

  it('sets cache headers', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(mockArticles);

    const res = await app.get('/v1/news').set('Authorization', 'Bearer test-key-123');
    expect(res.headers['cache-control']).toContain('public');
  });

  it('filters articles by search query q in v1 contract', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(mockArticles);

    const res = await app.get('/v1/news?q=economy').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { title: { contains: 'economy', mode: 'insensitive' } },
            { description: { contains: 'economy', mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });
});

describe('Rate limiting', () => {
  it('applies rate limit headers to API endpoints', async () => {
    const res = await app.get('/api/news');
    expect(res.status).toBe(401); // limiter runs before the API key check
    expect(res.headers['ratelimit-limit']).toBeDefined();
  });

  it('does not rate limit the health endpoint', async () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ '?column?': 1 }]);
    const res = await app.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBeUndefined();
  });
});

describe('Security headers', () => {
  it('includes security headers from helmet', async () => {
    const res = await app.get('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });
});
