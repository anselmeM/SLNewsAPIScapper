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
      count: vi.fn().mockResolvedValue(0),
    },
    video: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
    },
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

vi.mock('../services/video-scraper.js', () => ({
  runSierraLeoneVideoIngestion: vi.fn().mockResolvedValue({
    totalIngested: 3,
    totalSkipped: 1,
    totalErrors: 0,
  }),
}));

const mockVideos = [
  {
    id: 1,
    videoId: '3f4Y2N4w1bY',
    title: 'Freetown Port Expansion Project',
    url: 'https://www.youtube.com/watch?v=3f4Y2N4w1bY',
    description: 'Presidential commissioning of container terminal',
    thumbnailUrl: 'https://i.ytimg.com/vi/3f4Y2N4w1bY/hqdefault.jpg',
    channelId: 'UC6L0-X7Vb7iK2fN5iW6gZ0Q',
    channelTitle: 'AYV News Sierra Leone',
    publishedAt: new Date('2026-09-01T12:00:00Z'),
    category: ['National', 'Economy'],
    createdAt: new Date('2026-09-01T12:00:00Z'),
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

describe('GET /api/videos', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.get('/api/videos');
    expect(res.status).toBe(401);
  });

  it('returns paginated videos with 200 and X-Total-Count', async () => {
    (prisma.video.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockVideos);
    (prisma.video.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);

    const res = await app.get('/api/videos').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.headers['x-total-count']).toBe('1');
    expect(res.body).toHaveLength(1);
    expect(res.body[0].videoId).toBe('3f4Y2N4w1bY');
  });

  it('filters by channel and category', async () => {
    (prisma.video.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockVideos);
    (prisma.video.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);

    const res = await app.get('/api/videos?channel=AYV&category=Economy').set('Authorization', 'Bearer test-key-123');

    expect(res.status).toBe(200);
    expect(prisma.video.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          channelTitle: { contains: 'AYV', mode: 'insensitive' },
          category: { hasSome: ['Economy'] },
        }),
      }),
    );
  });

  it('returns 400 for invalid limit or page', async () => {
    const res1 = await app.get('/api/videos?limit=-5').set('Authorization', 'Bearer test-key-123');
    expect(res1.status).toBe(400);

    const res2 = await app.get('/api/videos?page=abc').set('Authorization', 'Bearer test-key-123');
    expect(res2.status).toBe(400);
  });

  it('filters videos by search term q', async () => {
    (prisma.video.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockVideos);
    (prisma.video.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);

    const res = await app.get('/api/videos?q=port').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(prisma.video.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { title: { contains: 'port', mode: 'insensitive' } },
            { description: { contains: 'port', mode: 'insensitive' } },
            { channelTitle: { contains: 'port', mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });

  it('returns 400 when search query q exceeds 100 characters', async () => {
    const longQuery = 'b'.repeat(101);
    const res = await app.get(`/api/videos?q=${longQuery}`).set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('100 characters');
  });
});

describe('GET /api/videos/:id', () => {
  it('returns video by numeric id', async () => {
    (prisma.video.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockVideos[0]);

    const res = await app.get('/api/videos/1').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.body.videoId).toBe('3f4Y2N4w1bY');
  });

  it('returns video by string videoId if numeric lookup misses', async () => {
    (prisma.video.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockVideos[0]);

    const res = await app.get('/api/videos/3f4Y2N4w1bY').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Freetown Port Expansion Project');
  });

  it('returns 404 if video is not found', async () => {
    (prisma.video.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await app.get('/api/videos/999').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/videos/sync', () => {
  it('triggers video ingestion and returns stats', async () => {
    const res = await app.post('/api/videos/sync').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.result).toEqual({
      totalIngested: 3,
      totalSkipped: 1,
      totalErrors: 0,
    });
  });
});

describe('GET /v1/videos', () => {
  it('returns versioned envelope with { data, meta }', async () => {
    (prisma.video.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockVideos);
    (prisma.video.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);

    const res = await app.get('/v1/videos').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.data[0]).toEqual({
      id: 1,
      video_id: '3f4Y2N4w1bY',
      title: 'Freetown Port Expansion Project',
      summary: 'Presidential commissioning of container terminal',
      source: 'AYV News Sierra Leone',
      category: ['National', 'Economy'],
      url: 'https://www.youtube.com/watch?v=3f4Y2N4w1bY',
      thumbnail_url: 'https://i.ytimg.com/vi/3f4Y2N4w1bY/hqdefault.jpg',
      published_at: mockVideos[0].publishedAt.toISOString(),
    });
    expect(res.body.meta).toEqual({
      page: 1,
      page_size: 20,
      total: 1,
      has_more: false,
    });
  });

  it('validates date range filters', async () => {
    const res = await app.get('/v1/videos?from=2026-09-10&to=2026-09-01').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/from must not be after to/i);
  });

  it('rejects page_size greater than 100', async () => {
    const res = await app.get('/v1/videos?page_size=150').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(400);
  });

  it('filters videos by search term q in v1 contract', async () => {
    (prisma.video.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockVideos);
    (prisma.video.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);

    const res = await app.get('/v1/videos?q=AYV').set('Authorization', 'Bearer test-key-123');
    expect(res.status).toBe(200);
    expect(prisma.video.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { title: { contains: 'AYV', mode: 'insensitive' } },
            { description: { contains: 'AYV', mode: 'insensitive' } },
            { channelTitle: { contains: 'AYV', mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });
});
