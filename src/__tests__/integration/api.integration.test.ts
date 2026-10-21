import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * Real-Postgres integration suite (P2-9).
 *
 * Skips cleanly when `DATABASE_URL` is absent, so `npm test`/local unit runs
 * never need a database. In CI (`integration` job) it runs against a
 * postgres:16 service after `npx prisma migrate deploy`; locally point
 * `DATABASE_URL` at a **disposable** database (this suite truncates tables).
 *
 * `src/db.js` and `src/server.js` are imported dynamically in `beforeAll`:
 * they read `DATABASE_URL`/`NODE_ENV` at module load, so a static import would
 * break the "skip without a database" contract.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIf = hasDatabase ? describe : describe.skip;

// CI supplies these; set defensively so a local disposable DB needs only
// DATABASE_URL. Static-key scopes stay at their defaults (both scopes) so the
// static key can exercise both API surfaces.
process.env.NODE_ENV = 'test';
process.env.API_KEY ??= 'integration-test-key';
delete process.env.CLERK_SECRET_KEY;
delete process.env.STATIC_KEY_SCOPES;
delete process.env.CLERK_SCOPES;

const API_KEY = process.env.API_KEY;
const AUTH = { Authorization: `Bearer ${API_KEY}` };

const LINKS = {
  portA: 'https://integration.example.test/articles/port-expansion-begins',
  portB: 'https://integration.example.test/articles/port-expansion-update',
  portC: 'https://integration.example.test/articles/port-workers-react',
  politics: 'https://integration.example.test/articles/parliament-budget',
  missing: 'https://integration.example.test/articles/undated-story',
  old: 'https://integration.example.test/articles/independence-retrospective',
};

type PrismaClientLike = typeof import('../../db.js').prisma;

let prisma: PrismaClientLike;
let app: Express;
let generateApiKey: typeof import('../../auth/apiKeys.js').generateApiKey;
let hashApiKey: typeof import('../../auth/apiKeys.js').hashApiKey;
let clearApiKeyCache: typeof import('../../auth/apiKeys.js').clearApiKeyCache;

interface SeededIds {
  articles: {
    portA: number;
    portB: number;
    portC: number;
    politics: number;
    missing: number;
    old: number;
  };
  videos: {
    ayv: number;
    slbc: number;
    missing: number;
    old: number;
  };
}

let seeded: SeededIds;

const api = () => request(app);

const sortIds = (ids: number[]): number[] => [...ids].sort((a, b) => a - b);

function dataIds(res: { body: { data?: Array<{ id: number }> } }): number[] {
  return (res.body.data ?? []).map((row) => row.id);
}

const utcDayStart = (now = new Date()): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

interface ArticleSeed {
  title: string;
  link: string;
  pubDate: Date;
  source: string;
  category?: string[];
  description?: string | null;
  paragraphs?: string[];
  pubDateSource?: string;
  contentSource?: string | null;
}

async function insertArticle(seed: ArticleSeed): Promise<number> {
  const row = await prisma.article.create({
    data: {
      title: seed.title,
      link: seed.link,
      author: 'Integration Author',
      description: seed.description === undefined ? `${seed.title} summary` : seed.description,
      category: seed.category ?? ['Politics'],
      imageUrl: null,
      paragraphs: seed.paragraphs ?? ['Integration paragraph one.', 'Integration paragraph two.'],
      pubDate: seed.pubDate,
      source: seed.source,
      pubDateSource: seed.pubDateSource ?? 'published',
      contentSource: seed.contentSource ?? 'page',
    },
    select: { id: true },
  });
  return row.id;
}

interface VideoSeed {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: Date;
  category?: string[];
  description?: string | null;
  publishedAtSource?: string;
}

async function insertVideo(seed: VideoSeed): Promise<number> {
  const row = await prisma.video.create({
    data: {
      videoId: seed.videoId,
      title: seed.title,
      url: `https://www.youtube.com/watch?v=${seed.videoId}`,
      description: seed.description === undefined ? `${seed.title} summary` : seed.description,
      thumbnailUrl: null,
      channelId: seed.channelId,
      channelTitle: seed.channelTitle,
      publishedAt: seed.publishedAt,
      category: seed.category ?? ['National'],
      publishedAtSource: seed.publishedAtSource ?? 'published',
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Three articles share `pubDate` on purpose so the keyset predicate must use
 * the `id` tiebreaker; the rest cover provenance exclusion and date filters.
 */
async function seedData(): Promise<SeededIds> {
  const duplicate = new Date('2026-09-01T10:00:00.000Z');

  const articles = {
    portA: await insertArticle({
      title: 'Freetown Port Expansion Begins',
      link: LINKS.portA,
      pubDate: duplicate,
      source: 'Politico SL',
      category: ['Economy'],
      description: 'Port expansion summary',
      paragraphs: ['Port paragraph one.', 'Port paragraph two.'],
    }),
    portB: await insertArticle({
      title: 'Port Expansion Update',
      link: LINKS.portB,
      pubDate: duplicate,
      source: 'Politico SL',
      category: ['Economy'],
      description: 'Update on the port works',
    }),
    portC: await insertArticle({
      title: 'Port Workers React',
      link: LINKS.portC,
      pubDate: duplicate,
      source: 'Politico SL',
      category: ['Economy'],
      description: 'Workers react to the port works',
    }),
    politics: await insertArticle({
      title: 'Parliament Debates Budget',
      link: LINKS.politics,
      pubDate: new Date('2026-08-15T09:00:00.000Z'),
      source: 'The Sierra Leone Telegraph',
      category: ['Politics'],
      description: 'Budget debate summary',
      paragraphs: [],
      contentSource: 'empty',
    }),
    missing: await insertArticle({
      title: 'Undated Breaking Story',
      link: LINKS.missing,
      pubDate: new Date('2026-09-02T00:00:00.000Z'),
      source: 'Concord Times',
      category: ['Politics'],
      description: 'Undated story summary',
      paragraphs: ['Internal full text only.'],
      pubDateSource: 'missing',
    }),
    old: await insertArticle({
      title: 'Independence Day Retrospective',
      link: LINKS.old,
      pubDate: new Date('2026-06-01T00:00:00.000Z'),
      source: 'Concord Times',
      category: ['Culture'],
    }),
  };

  const videos = {
    ayv: await insertVideo({
      videoId: 'vidAyvIntegration01',
      title: 'Freetown Port Expansion Commissioned',
      channelId: 'UC_integration_ayv',
      channelTitle: 'AYV News Sierra Leone',
      publishedAt: new Date('2026-09-01T12:00:00.000Z'),
      category: ['National'],
    }),
    slbc: await insertVideo({
      videoId: 'vidSlbcIntegration1',
      title: 'Budget Speech Highlights',
      channelId: 'UC_integration_slbc',
      channelTitle: 'SLBC National TV',
      publishedAt: new Date('2026-09-01T12:00:00.000Z'),
      category: ['National'],
    }),
    missing: await insertVideo({
      videoId: 'vidMissingIntegration',
      title: 'Undated Video Report',
      channelId: 'UC_integration_ayv',
      channelTitle: 'AYV News Sierra Leone',
      publishedAt: new Date('2026-09-02T00:00:00.000Z'),
      category: ['National'],
      publishedAtSource: 'missing',
    }),
    old: await insertVideo({
      videoId: 'vidOldIntegration01',
      title: 'Independence Day Parade',
      channelId: 'UC_integration_slbc',
      channelTitle: 'SLBC National TV',
      publishedAt: new Date('2026-06-01T00:00:00.000Z'),
      category: ['National'],
    }),
  };

  return { articles, videos };
}

async function createDbKey(scopes: string[]): Promise<{ id: number; raw: string }> {
  const raw = generateApiKey();
  const row = await prisma.apiKey.create({
    data: { name: 'Integration customer', keyHash: hashApiKey(raw), scopes },
    select: { id: true },
  });
  return { id: row.id, raw };
}

async function getV1NewsPage(pageSize: number, cursor?: string) {
  const cursorQuery = cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`;
  return api().get(`/v1/news?page_size=${pageSize}${cursorQuery}`).set(AUTH);
}

async function expectedV1ArticleIds(): Promise<number[]> {
  const rows = await prisma.article.findMany({
    where: { pubDateSource: { not: 'missing' } },
    orderBy: [{ pubDate: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

describeIf('real-Postgres API integration', () => {
  beforeAll(async () => {
    const dbModule = await import('../../db.js');
    prisma = dbModule.prisma;

    const apiKeysModule = await import('../../auth/apiKeys.js');
    generateApiKey = apiKeysModule.generateApiKey;
    hashApiKey = apiKeysModule.hashApiKey;
    clearApiKeyCache = apiKeysModule.clearApiKeyCache;

    const serverModule = await import('../../server.js');
    app = serverModule.default as unknown as Express;

    // The committed migrations must have created the provenance, API-key and
    // usage columns/tables — a mocked Prisma client can never prove this.
    const columns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string; data_type: string }>>`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('Article', 'Video', 'ApiKey', 'ApiKeyUsage')
    `;
    const columnNames = new Set(columns.map((column) => `${column.table_name}.${column.column_name}`));
    for (const expected of [
      'Article.pubDateSource',
      'Article.pubDateRaw',
      'Article.contentSource',
      'Article.contentAttempts',
      'Video.publishedAtSource',
      'ApiKey.keyHash',
      'ApiKeyUsage.requests',
    ]) {
      expect(columnNames.has(expected)).toBe(true);
    }
    expect(
      columns.find((column) => column.table_name === 'ApiKeyUsage' && column.column_name === 'day')?.data_type,
    ).toBe('date');

    const migrations = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    expect(migrations[0]?.count ?? 0).toBeGreaterThanOrEqual(4);
  });

  beforeEach(async () => {
    clearApiKeyCache();
    // FK-safe order: usage rows reference ApiKey.
    await prisma.apiKeyUsage.deleteMany();
    await prisma.apiKey.deleteMany();
    await prisma.article.deleteMany();
    await prisma.video.deleteMany();
    seeded = await seedData();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('/v1/news page mode returns total/has_more/next_cursor and metadata only', async () => {
    const res = await api().get('/v1/news?page_size=2').set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({
      title: 'Port Workers React',
      summary: 'Workers react to the port works',
      source: 'Politico SL',
      category: ['Economy'],
      url: LINKS.portC,
      published_at: '2026-09-01T10:00:00.000Z',
    });
    // The sellable contract never exposes full text or internal provenance.
    expect(res.body.data[0]).not.toHaveProperty('paragraphs');
    expect(res.body.data[0]).not.toHaveProperty('contentSource');
    expect(res.body.meta).toMatchObject({ page: 1, page_size: 2, total: 5, has_more: true });
    expect(typeof res.body.meta.next_cursor).toBe('string');
  });

  it('excludes missing-date rows from /v1/news but keeps them (with paragraphs) in /api/news', async () => {
    const v1 = await api().get('/v1/news?page_size=100').set(AUTH);
    expect(v1.status).toBe(200);
    expect(dataIds(v1)).not.toContain(seeded.articles.missing);
    expect(v1.body.meta.total).toBe(5);

    const legacy = await api().get('/api/news?limit=100').set(AUTH);
    expect(legacy.status).toBe(200);
    expect(dataIds({ body: { data: legacy.body } })).toContain(seeded.articles.missing);
    const missingRow = (legacy.body as Array<{ id: number; paragraphs?: string[]; pubDateSource?: string }>).find(
      (row) => row.id === seeded.articles.missing,
    );
    expect(missingRow?.paragraphs).toEqual(['Internal full text only.']);
    expect(missingRow?.pubDateSource).toBe('missing');

    const search = await api().get('/v1/news?q=Undated').set(AUTH);
    expect(search.status).toBe(200);
    expect(search.body.data).toEqual([]);
  });

  it('cursor keyset walks duplicate pubDates with no gaps, duplicates or reordering', async () => {
    const expected = await expectedV1ArticleIds();
    expect(expected).toHaveLength(5);

    const collected: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    while (true) {
      const requestedCursor: string | null = cursor;
      const res = await getV1NewsPage(2, requestedCursor ?? undefined);
      expect(res.status).toBe(200);
      if (requestedCursor !== null) {
        // Cursor mode skips the count query.
        expect(res.body.meta.page).toBeNull();
        expect(res.body.meta.total).toBeNull();
      }
      collected.push(...dataIds(res));
      cursor = (res.body.meta.next_cursor as string | null) ?? null;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(5);
      if (cursor === null) break;
    }

    expect(collected).toEqual(expected);
    expect(new Set(collected).size).toBe(collected.length);

    // Page-based paging over the same dataset yields the identical order.
    const byPage: number[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const res = await api().get(`/v1/news?page=${page}&page_size=2`).set(AUTH);
      expect(res.status).toBe(200);
      byPage.push(...dataIds(res));
      if (!res.body.meta.has_more) break;
    }
    expect(byPage).toEqual(expected);
  });

  it('runs search, category and date filters as real SQL', async () => {
    const portIds = sortIds([seeded.articles.portA, seeded.articles.portB, seeded.articles.portC]);

    const search = await api().get('/v1/news?q=port').set(AUTH);
    expect(search.status).toBe(200);
    expect(sortIds(dataIds(search))).toEqual(portIds);

    const caseInsensitive = await api().get('/v1/news?q=PORT').set(AUTH);
    expect(sortIds(dataIds(caseInsensitive))).toEqual(portIds);

    const economy = await api().get('/v1/news?category=Economy').set(AUTH);
    expect(sortIds(dataIds(economy))).toEqual(portIds);

    const politics = await api().get('/v1/news?category=Politics').set(AUTH);
    expect(dataIds(politics)).toEqual([seeded.articles.politics]);

    const august = await api().get('/v1/news?from=2026-08-01&to=2026-08-31').set(AUTH);
    expect(dataIds(august)).toEqual([seeded.articles.politics]);

    // `to` is date-only and inclusive of the whole day.
    const septemberFirst = await api().get('/v1/news?from=2026-09-01&to=2026-09-01').set(AUTH);
    expect(sortIds(dataIds(septemberFirst))).toEqual(portIds);

    const combined = await api().get('/v1/news?q=port&category=Economy&from=2026-09-01&to=2026-09-30').set(AUTH);
    expect(sortIds(dataIds(combined))).toEqual(portIds);
  });

  it('/v1/videos applies channel/date filters and excludes missing-date rows', async () => {
    const all = await api().get('/v1/videos?page_size=100').set(AUTH);
    expect(all.status).toBe(200);
    expect(sortIds(dataIds(all))).toEqual(sortIds([seeded.videos.ayv, seeded.videos.slbc, seeded.videos.old]));
    expect(dataIds(all)).not.toContain(seeded.videos.missing);

    const ayv = await api().get('/v1/videos?channel=AYV').set(AUTH);
    expect(dataIds(ayv)).toEqual([seeded.videos.ayv]);

    const recent = await api().get('/v1/videos?from=2026-08-15').set(AUTH);
    expect(sortIds(dataIds(recent))).toEqual(sortIds([seeded.videos.ayv, seeded.videos.slbc]));

    const search = await api().get('/v1/videos?q=Budget').set(AUTH);
    expect(dataIds(search)).toEqual([seeded.videos.slbc]);

    const legacy = await api().get('/api/videos?limit=100').set(AUTH);
    expect(legacy.status).toBe(200);
    expect((legacy.body as Array<{ id: number }>).map((row) => row.id)).toContain(seeded.videos.missing);
  });

  it('DB-backed API keys enforce v1:read vs internal:read scopes', async () => {
    const v1Key = await createDbKey(['v1:read']);
    const internalKey = await createDbKey(['internal:read']);
    clearApiKeyCache();

    const v1OnV1 = await api().get('/v1/news').set('Authorization', `Bearer ${v1Key.raw}`);
    expect(v1OnV1.status).toBe(200);

    const v1OnApi = await api().get('/api/news').set('Authorization', `Bearer ${v1Key.raw}`);
    expect(v1OnApi.status).toBe(403);
    expect(v1OnApi.body).toEqual({
      error: 'Forbidden — credential lacks required scope',
      required_scope: 'internal:read',
    });

    const internalOnApi = await api().get('/api/news').set('Authorization', `Bearer ${internalKey.raw}`);
    expect(internalOnApi.status).toBe(200);

    const internalOnV1 = await api().get('/v1/news').set('Authorization', `Bearer ${internalKey.raw}`);
    expect(internalOnV1.status).toBe(403);
    expect(internalOnV1.body.required_scope).toBe('v1:read');
  });

  it("records today's usage row and lastUsedAt for an authenticated DB key", async () => {
    const key = await createDbKey(['v1:read']);
    clearApiKeyCache();

    const res = await api().get('/v1/news?page_size=1').set('Authorization', `Bearer ${key.raw}`);
    expect(res.status).toBe(200);

    const day = utcDayStart();
    await vi.waitFor(
      async () => {
        const usage = await prisma.apiKeyUsage.findUnique({
          where: { apiKeyId_day: { apiKeyId: key.id, day } },
        });
        const row = await prisma.apiKey.findUnique({ where: { id: key.id }, select: { lastUsedAt: true } });
        expect(usage?.requests ?? 0).toBeGreaterThanOrEqual(1);
        expect(row?.lastUsedAt).toBeInstanceOf(Date);
      },
      { timeout: 5000, interval: 100 },
    );

    const usage = await prisma.apiKeyUsage.findUnique({
      where: { apiKeyId_day: { apiKeyId: key.id, day } },
    });
    expect(usage?.day.toISOString().slice(0, 10)).toBe(day.toISOString().slice(0, 10));
  });

  it('stats expose provenance counters computed from real rows', async () => {
    const res = await api().get('/api/stats').set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.articles.total).toBe(6);
    expect(res.body.articles.missing_date).toBe(1);
    expect(res.body.articles.empty_content).toBe(1);
    expect(res.body.videos.total).toBe(4);
    expect(res.body.videos.missing_date).toBe(1);
    // Rows were just created, so the default 2h freshness window is not stale.
    expect(res.body.freshness.articles.stale).toBe(false);
    expect(res.body.freshness.videos.stale).toBe(false);
  });

  it('enforces Article.link uniqueness through upsert (real unique index)', async () => {
    const link = LINKS.portA;
    expect(await prisma.article.count({ where: { link } })).toBe(1);

    await prisma.article.upsert({
      where: { link },
      update: { title: 'Freetown Port Expansion (updated)' },
      create: {
        title: 'Duplicate insert that must not win',
        link,
        author: 'Integration Author',
        category: [],
        paragraphs: [],
        pubDate: new Date(),
        source: 'Politico SL',
      },
    });

    expect(await prisma.article.count({ where: { link } })).toBe(1);
    const row = await prisma.article.findUnique({ where: { link }, select: { title: true } });
    expect(row?.title).toBe('Freetown Port Expansion (updated)');

    await expect(
      prisma.article.create({
        data: {
          title: 'Duplicate insert that must fail',
          link,
          author: 'Integration Author',
          category: [],
          paragraphs: [],
          pubDate: new Date(),
          source: 'Politico SL',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
