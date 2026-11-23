import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '../db.js';
import { encodeCursor } from '../utils/pagination.js';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('GET /api/health (liveness)', () => {
  it('returns 200 with liveness info and never touches the database', async () => {
    const queryRaw = prisma.$queryRaw as ReturnType<typeof vi.fn>;
    queryRaw.mockClear();

    const res = await app.get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('sl-news-api');
    expect(res.body.uptime_seconds).toEqual(expect.any(Number));
    expect(res.body).toHaveProperty('commit');
    expect(res.body.timestamp).toBeDefined();
    // Liveness must not depend on the database (that is /api/ready's job), so a
    // database outage can never make the platform restart a healthy process.
    expect(res.body.database).toBeUndefined();
    expect(queryRaw).not.toHaveBeenCalled();
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('GET /api/ready (readiness)', () => {
  it('returns 200 when the database is reachable', async () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ '?column?': 1 }]);

    const res = await app.get('/api/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.database).toBe('connected');
    expect(res.body.timestamp).toBeDefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns 503 when the database is unreachable', async () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Connection failed'));

    const res = await app.get('/api/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.database).toBe('disconnected');
  });
});

describe('request correlation id', () => {
  it('returns a generated X-Request-Id header', async () => {
    const res = await app.get('/api/health');

    expect(res.headers['x-request-id']).toMatch(UUID_RE);
  });

  it('echoes a valid inbound X-Request-Id', async () => {
    const inbound = 'client-request_01.abc';

    const res = await app.get('/api/health').set('X-Request-Id', inbound);

    expect(res.headers['x-request-id']).toBe(inbound);
  });

  it('replaces an invalid (too short) inbound X-Request-Id', async () => {
    const res = await app.get('/api/health').set('X-Request-Id', 'abc');

    expect(res.headers['x-request-id']).toMatch(UUID_RE);
    expect(res.headers['x-request-id']).not.toBe('abc');
  });

  it('replaces an over-long inbound X-Request-Id', async () => {
    const res = await app.get('/api/health').set('X-Request-Id', 'a'.repeat(129));

    expect(res.headers['x-request-id']).toMatch(UUID_RE);
  });

  it('includes request_id in the 404 body, matching the response header', async () => {
    const res = await app.get('/api/nonexistent');

    expect(res.status).toBe(404);
    expect(res.body.request_id).toBe(res.headers['x-request-id']);
  });

  it('includes request_id in the error body (malformed JSON -> 400)', async () => {
    const res = await app.post('/api/news').set('Content-Type', 'application/json').send('{"broken":');

    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ error: 'Bad request' }));
    expect(res.body.request_id).toEqual(expect.any(String));
    expect(res.body.request_id).toBe(res.headers['x-request-id']);
  });
});

describe('GET /', () => {
  it('returns API info with endpoints', async () => {
    const res = await app.get('/');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Sierra Leone News API');
    expect(res.body.endpoints.news).toBeDefined();
    expect(res.body.endpoints.health).toBeDefined();
    expect(res.body.endpoints.ready).toBe('/api/ready');
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
    expect(res.headers['cache-control']).toContain('private');
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

  it('rejects an absurd page as a 400 instead of a Prisma 500', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockClear();

    for (const page of ['1000000000', '1e21']) {
      const res = await app.get(`/api/news?page=${page}`).set('Authorization', 'Bearer test-key-123');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('page');
    }
    // The bad page must be rejected before the database is queried.
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('caps legacy offset pagination at page 10000', async () => {
    const res = await app.get('/api/news?page=10001').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('page must not exceed 10000');
  });

  it('still clamps limit above 100 for the pinned legacy client', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(mockArticles);

    const res = await app.get('/api/news?limit=1000').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
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
    expect(res.headers['cache-control']).toContain('private');
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

  const cursorRows = [
    {
      id: 41,
      title: 'Cursor A',
      link: 'https://example.com/cursor-a',
      description: 'Cursor A summary',
      category: ['Politics'],
      pubDate: new Date('2026-08-06T00:00:00.000Z'),
      source: 'Politico SL',
    },
    {
      id: 40,
      title: 'Cursor B',
      link: 'https://example.com/cursor-b',
      description: 'Cursor B summary',
      category: ['Politics'],
      pubDate: new Date('2026-08-05T00:00:00.000Z'),
      source: 'Politico SL',
    },
    {
      id: 39,
      title: 'Cursor C',
      link: 'https://example.com/cursor-c',
      description: 'Cursor C summary',
      category: ['Politics'],
      pubDate: new Date('2026-08-04T00:00:00.000Z'),
      source: 'Politico SL',
    },
  ];

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
      // No followable subject in this headline.
      teams: [],
    });
    expect(res.body.meta).toEqual({ page: 1, page_size: 20, total: 1, has_more: false, next_cursor: null });
    // Sellable feed excludes rows whose published date could not be parsed.
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ pubDateSource: { not: 'missing' } }) }),
    );
  });

  it('excludes undated items on /v1 but keeps them on the legacy /api feed', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    const mockCount = prisma.article.count as ReturnType<typeof vi.fn>;
    mockFindMany.mockClear();
    mockCount.mockClear();

    mockFindMany.mockResolvedValueOnce([]);
    mockCount.mockResolvedValueOnce(0);

    await app.get('/v1/news').set('Authorization', 'Bearer test-key-123');
    const v1Args = mockFindMany.mock.calls[0][0];
    expect(v1Args.where.pubDateSource).toEqual({ not: 'missing' });
    expect(mockCount.mock.calls[0][0]).toEqual({
      where: expect.objectContaining({ pubDateSource: { not: 'missing' } }),
    });

    mockFindMany.mockClear();
    mockCount.mockClear();
    mockFindMany.mockResolvedValueOnce(mockArticles);
    mockCount.mockResolvedValueOnce(1);

    const legacyRes = await app.get('/api/news').set('Authorization', 'Bearer test-key-123');
    expect(legacyRes.status).toBe(200);
    const apiArgs = mockFindMany.mock.calls[0][0];
    expect(apiArgs.where).toBeUndefined();
    expect(mockCount.mock.calls[0][0].where).toBeUndefined();
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
    expect(res.body.meta).toEqual({ page: 2, page_size: 10, total: 1, has_more: false, next_cursor: null });
  });

  it('returns a bootstrap cursor from page mode when more results exist', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    const mockCount = prisma.article.count as ReturnType<typeof vi.fn>;
    mockFindMany.mockClear();
    mockCount.mockClear();
    mockFindMany.mockResolvedValueOnce(mockArticles);
    mockCount.mockResolvedValueOnce(5);

    const res = await app.get('/v1/news?page_size=1&page=1').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.body.meta.has_more).toBe(true);
    // Page mode hands out the keyset position so clients can switch to `cursor=`
    // without paying for deep OFFSETs/counts on subsequent pages.
    expect(res.body.meta.next_cursor).toBe(encodeCursor(mockArticles[0].pubDate, mockArticles[0].id));
  });

  it('paginates with a cursor without running a count query (keyset)', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    const mockCount = prisma.article.count as ReturnType<typeof vi.fn>;
    mockFindMany.mockClear();
    mockCount.mockClear();

    const cursorDate = new Date('2026-08-07T12:00:00.000Z');
    const cursor = encodeCursor(cursorDate, 42);
    mockFindMany.mockResolvedValueOnce(cursorRows);

    const res = await app
      .get(`/v1/news?page_size=2&source=Politico%20SL&cursor=${cursor}`)
      .set('Authorization', 'Bearer test-key-123');

    expect(res.status).toBe(200);
    const args = mockFindMany.mock.calls[0][0];
    expect(args.take).toBe(3);
    expect(args.skip).toBeUndefined();
    expect(args.orderBy).toEqual([{ pubDate: 'desc' }, { id: 'desc' }]);
    // Filters stay direct properties; the keyset predicate lives under AND.
    expect(args.where.source).toBe('Politico SL');
    expect(args.where.AND).toEqual([
      { OR: [{ pubDate: { lt: cursorDate } }, { pubDate: cursorDate, id: { lt: 42 } }] },
    ]);
    expect(mockCount).not.toHaveBeenCalled();

    expect(res.body.data.map((row: { id: number }) => row.id)).toEqual([41, 40]);
    expect(res.body.meta).toEqual({
      page: null,
      page_size: 2,
      total: null,
      has_more: true,
      next_cursor: encodeCursor(cursorRows[1].pubDate, 40),
    });
  });

  it('combines the cursor keyset with the search OR under AND', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    const mockCount = prisma.article.count as ReturnType<typeof vi.fn>;
    mockFindMany.mockClear();
    mockCount.mockClear();

    const cursorDate = new Date('2026-08-07T12:00:00.000Z');
    const cursor = encodeCursor(cursorDate, 42);
    mockFindMany.mockResolvedValueOnce([cursorRows[0]]);

    const res = await app
      .get(`/v1/news?q=port&page_size=2&cursor=${cursor}`)
      .set('Authorization', 'Bearer test-key-123');

    expect(res.status).toBe(200);
    const args = mockFindMany.mock.calls[0][0];
    expect(args.where.OR).toBeUndefined();
    expect(args.where.AND).toEqual([
      {
        OR: [
          { title: { contains: 'port', mode: 'insensitive' } },
          { description: { contains: 'port', mode: 'insensitive' } },
        ],
      },
      { OR: [{ pubDate: { lt: cursorDate } }, { pubDate: cursorDate, id: { lt: 42 } }] },
    ]);
    expect(mockCount).not.toHaveBeenCalled();
    expect(res.body.meta.has_more).toBe(false);
    expect(res.body.meta.next_cursor).toBeNull();
  });

  it('returns 400 when page and cursor are both supplied', async () => {
    const cursor = encodeCursor(new Date('2026-08-07T00:00:00.000Z'), 1);
    const res = await app.get(`/v1/news?page=1&cursor=${cursor}`).set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('use either page or cursor, not both');
  });

  it('returns 400 for an invalid cursor', async () => {
    const res = await app.get('/v1/news?cursor=not-a-cursor').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('cursor is invalid');
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

  it('accepts a time-of-day from when to is the same date-only day', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(mockArticles);

    const res = await app
      .get('/v1/news?from=2026-08-07T12:00:00Z&to=2026-08-07')
      .set('Authorization', 'Bearer test-key-123');

    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          pubDate: {
            gte: new Date('2026-08-07T12:00:00Z'),
            lte: new Date('2026-08-07T23:59:59.999Z'),
          },
        }),
      }),
    );
  });

  it('returns 400 for an impossible calendar date', async () => {
    const res = await app.get('/v1/news?from=2026-02-30').set('Authorization', 'Bearer test-key-123');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('from must be a valid ISO date');
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
    expect(res.headers['cache-control']).toContain('private');
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

describe('public read-only content', () => {
  it('serves the summary-only v1 news payload without authentication', async () => {
    const mockFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce(mockArticles);

    const res = await app.get('/v1/public/news');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).not.toHaveProperty('paragraphs');
    expect(res.body.data[0].title).toBe('Test Article');
  });

  it('does not expose public stats or internal routes', async () => {
    const stats = await app.get('/v1/public/stats');
    const news = await app.get('/api/public/news');

    expect(stats.status).toBe(404);
    expect(news.status).toBe(404);
  });

  it('serves public videos without authentication', async () => {
    const mockFindMany = prisma.video.findMany as ReturnType<typeof vi.fn>;
    mockFindMany.mockResolvedValueOnce([]);

    const res = await app.get('/v1/public/videos');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('Rate limiting', () => {
  it('applies rate limit headers to API endpoints', async () => {
    const res = await app.get('/api/news');
    expect(res.status).toBe(401); // limiter runs before the API key check
    expect(res.headers['ratelimit-limit']).toBeDefined();
  });

  it('does not rate limit the liveness endpoint', async () => {
    const res = await app.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBeUndefined();
  });

  it('does not rate limit the readiness endpoint', async () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ '?column?': 1 }]);
    const res = await app.get('/api/ready');
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
