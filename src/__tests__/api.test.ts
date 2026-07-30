import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '../db.js';

vi.mock('../db.js', () => ({
  prisma: {
    article: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
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

  it('returns 400 for invalid limit', async () => {
    const res = await app.get('/api/news?limit=0').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('limit');
  });

  it('returns 400 for invalid source', async () => {
    const res = await app.get('/api/news?source=InvalidSource').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid source');
  });
});

describe('GET /api/news/:id', () => {
  it('returns 400 for non-numeric id', async () => {
    const res = await app.get('/api/news/abc').set('Authorization', 'Bearer test-key-123');
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
});

describe('Rate limiting', () => {
  it('includes rate limit headers', async () => {
    const res = await app.get('/api/health');
    expect(res.headers['ratelimit-limit']).toBeDefined();
  });
});

describe('Security headers', () => {
  it('includes security headers from helmet', async () => {
    const res = await app.get('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });
});
