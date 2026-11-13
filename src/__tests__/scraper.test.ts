import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import logger from '../logger.js';
import { __resetSourceHealth } from '../services/source-health.js';

vi.mock('../db.js', () => ({
  prisma: {
    article: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({ id: 1 }),
      upsert: vi.fn().mockResolvedValue({ id: 1 }),
    },
    video: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({ id: 1 }),
    },
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

const FEED_URLS = [
  'https://www.thesierraleonetelegraph.com/feed/',
  'https://politicosl.com/rss.xml',
  'https://sierraleoneconcordtimes.com/feed/',
];
const TELEGRAPH_SITEMAP_PAGE = (page: number) =>
  `https://www.thesierraleonetelegraph.com/wp-sitemap-posts-post-${page}.xml`;
const ARTICLE_PREFIX = 'https://example.com/article-';
const REPAIR_PREFIX = 'https://example.com/repair-';
const SITEMAP_STORY = 'https://example.com/sitemap-story';
const YOUTUBE_FEED_PREFIX = 'https://www.youtube.com/feeds/videos.xml?channel_id=';

const DEFAULT_FEED_DATE = 'Fri, 09 Oct 2026 12:00:00 GMT';

const EMPTY_ATOM_FEED =
  '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Empty</title></feed>';

type Mock = ReturnType<typeof vi.fn>;

/** The batched dedupe select (metadata + content provenance for repair). */
const EXISTING_ARTICLE_SELECT = {
  id: true,
  link: true,
  imageUrl: true,
  description: true,
  category: true,
  source: true,
  paragraphs: true,
  contentSource: true,
  contentAttempts: true,
};

/** The bounded repair sweep query. */
const REPAIR_SWEEP_QUERY = {
  where: { contentSource: { in: ['empty', 'summary'] }, contentAttempts: { lt: 3 } },
  orderBy: { createdAt: 'asc' },
  take: 5,
  select: { id: true, link: true, source: true },
};

interface TestFeedItem {
  link: string;
  title: string;
  /** '' omits the <pubDate> element entirely. */
  pubDate?: string;
  /** RSS description; the parser exposes it as content + contentSnippet. */
  content?: string;
  categories?: string[];
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rssXml(items: TestFeedItem[]): string {
  const itemsXml = items
    .map((item) => {
      const pubDate = item.pubDate === undefined ? DEFAULT_FEED_DATE : item.pubDate;
      return `
    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      ${pubDate ? `<pubDate>${escapeXml(pubDate)}</pubDate>` : ''}
      ${item.content ? `<description><![CDATA[${item.content}]]></description>` : ''}
      ${(item.categories ?? []).map((category) => `<category>${escapeXml(category)}</category>`).join('')}
    </item>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Test Feed</title>${itemsXml}</channel></rss>`;
}

function sitemapXml(urls: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((url) => `<url><loc>${url}</loc></url>`)
    .join('')}</urlset>`;
}

function httpError(status: number): Error {
  const error = new Error(`HTTP ${status}`) as Error & { response: { status: number } };
  error.response = { status };
  return error;
}

/** Default routes: configured feeds (XML), sitemap 404 (end), empty YouTube feeds. */
function baseRoutes(feeds: Partial<Record<string, TestFeedItem[]>> = {}) {
  return (url: string): string | Error | undefined => {
    if (FEED_URLS.includes(url)) return rssXml(feeds[url] ?? []);
    if (url.startsWith('https://www.thesierraleonetelegraph.com/wp-sitemap-posts-post-')) return httpError(404);
    if (url.startsWith(YOUTUBE_FEED_PREFIX)) return EMPTY_ATOM_FEED;
    return undefined;
  };
}

function mockHttp(handler: (url: string) => string | Error | undefined) {
  const axiosGet = axios.get as Mock;
  axiosGet.mockImplementation(async (url: string) => {
    const result = handler(String(url));
    if (result === undefined) throw new Error(`Unexpected HTTP request: ${url}`);
    if (result instanceof Error) throw result;
    return { data: result, status: 200, headers: {} };
  });
}

function httpCalls(): string[] {
  return (axios.get as Mock).mock.calls.map(([url]) => String(url));
}

function articlePageCalls(): string[] {
  return httpCalls().filter((url) => url.startsWith(ARTICLE_PREFIX));
}

function existingRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    link: `${ARTICLE_PREFIX}1`,
    imageUrl: 'https://example.com/existing.jpg',
    description: 'Existing description',
    category: ['News'],
    source: 'The Sierra Leone Telegraph',
    paragraphs: ['Existing body paragraph.'],
    contentSource: 'page',
    contentAttempts: 0,
    ...overrides,
  };
}

/** findMany implementation: source batch -> rows, sitemap links -> known, sweep -> candidates. */
function findManyRouting(options: {
  rows?: (links: string[]) => Record<string, unknown>[];
  knownLinks?: string[];
  repairCandidates?: Array<{ id: number; link: string; source: string }>;
}) {
  return (args: {
    where?: { link?: { in?: string[] }; source?: string; contentSource?: unknown };
  }): Promise<unknown[]> => {
    if (args.where?.contentSource) return Promise.resolve(options.repairCandidates ?? []);
    if (args.where?.source) return Promise.resolve((options.knownLinks ?? []).map((link) => ({ link })));
    const links = args.where?.link?.in ?? [];
    return Promise.resolve(options.rows ? options.rows(links) : []);
  };
}

async function articleMocks() {
  const { prisma } = await import('../db.js');
  return {
    findMany: prisma.article.findMany as Mock,
    findUnique: prisma.article.findUnique as Mock,
    update: prisma.article.update as Mock,
    upsert: prisma.article.upsert as Mock,
    videoFindMany: prisma.video.findMany as Mock,
    videoUpsert: prisma.video.upsert as Mock,
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  __resetSourceHealth();
  (axios.get as Mock).mockReset();

  const mocks = await articleMocks();
  mocks.findMany.mockReset().mockResolvedValue([]);
  mocks.findUnique.mockReset().mockResolvedValue(null);
  mocks.update.mockReset().mockResolvedValue({ id: 1 });
  mocks.upsert.mockReset().mockResolvedValue({ id: 1 });
  mocks.videoFindMany.mockReset().mockResolvedValue([]);
  mocks.videoUpsert.mockReset().mockResolvedValue({ id: 1 });
});

describe('runSierraLeoneIngestion', () => {
  it('fills missing metadata on an existing article from one batched findMany', async () => {
    const link = `${ARTICLE_PREFIX}1`;
    mockHttp(
      baseRoutes({
        [FEED_URLS[0]]: [
          {
            link,
            title: 'Existing Article',
            content: '<p>Feed body paragraph.</p><img src="https://example.com/thumb.jpg">',
            categories: ['Politics'],
          },
        ],
      }),
    );

    const { findMany, findUnique, update, upsert } = await articleMocks();
    const row = existingRow({ id: 7, link, imageUrl: null, description: null, category: [] });
    findMany.mockImplementation(findManyRouting({ rows: (links) => (links.includes(link) ? [row] : []) }));

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion({ skipImageBackfill: true });

    // Batched dedupe: one findMany for the source, no per-item findUnique.
    expect(findMany).toHaveBeenCalledWith({ where: { link: { in: [link] } }, select: EXISTING_ARTICLE_SELECT });
    expect(findUnique).not.toHaveBeenCalled();

    // One update per existing article, only with the fields that were missing.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: {
        imageUrl: 'https://example.com/thumb.jpg',
        description: 'Feed body paragraph.',
        category: ['Politics'],
      },
    });
    expect(upsert).not.toHaveBeenCalled();
    // Feed HTML already had the image, so no article page fetch was needed.
    expect(articlePageCalls()).toHaveLength(0);
    // Feeds go through the retry path (axios) instead of rss-parser.parseURL.
    expect(httpCalls()).toContain(FEED_URLS[0]);
  });

  it('does not overwrite existing complete metadata', async () => {
    const link = `${ARTICLE_PREFIX}2`;
    mockHttp(
      baseRoutes({
        [FEED_URLS[0]]: [
          {
            link,
            title: 'Complete Article',
            content: '<p>Body</p><img src="https://example.com/feed-image.jpg">',
            categories: ['Politics'],
          },
        ],
      }),
    );

    const { findMany, update, upsert } = await articleMocks();
    const row = existingRow({
      id: 11,
      link,
      imageUrl: 'https://example.com/existing.jpg',
      description: 'Existing description',
      category: ['Old Category'],
    });
    findMany.mockImplementation(findManyRouting({ rows: (links) => (links.includes(link) ? [row] : []) }));

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion({ skipImageBackfill: true });

    expect(update).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(articlePageCalls()).toHaveLength(0);
  });

  it('caps article-page image fetches at 10 across all feeds in one run', async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      link: `${ARTICLE_PREFIX}${i}`,
      title: `Article ${i}`,
      content: '<p>Feed content without any images.</p>',
      categories: ['News'],
    }));
    const feeds = Object.fromEntries(
      FEED_URLS.map((url, feedIndex) => [
        url,
        items.map((item, itemIndex) => {
          const words = [
            'alpha',
            'bravo',
            'charlie',
            'delta',
            'echo',
            'foxtrot',
            'golf',
            'hotel',
            'india',
            'juliet',
            'kilo',
            'lima',
            'mike',
            'november',
            'oscar',
            'papa',
            'quebec',
            'romeo',
            'sierra',
            'tango',
            'uniform',
            'victor',
            'whiskey',
            'xray',
            'yankee',
            'zulu',
            'amber',
            'bronze',
            'copper',
            'denim',
            'emerald',
            'flint',
            'garnet',
            'hazel',
            'ivory',
            'jade',
          ];
          return {
            ...item,
            link: `${ARTICLE_PREFIX}${feedIndex}-${itemIndex}`,
            title: `${words[feedIndex * 12 + itemIndex]} bulletin`,
          };
        }),
      ]),
    );

    mockHttp((url) => {
      if (url.startsWith(ARTICLE_PREFIX)) return '<html><head></head><body></body></html>';
      return baseRoutes(feeds)(url);
    });

    const { findMany, findUnique, update } = await articleMocks();
    findMany.mockImplementation(
      findManyRouting({
        rows: (links) =>
          links.map((link, index) =>
            existingRow({
              id: index + 1,
              link,
              imageUrl: null,
              description: 'Existing description',
              category: ['News'],
              source: 'News',
            }),
          ),
      }),
    );

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion({ skipImageBackfill: true });

    // 36 candidates in one run (12 items x 3 feeds), but only 10 page fetches.
    expect(articlePageCalls()).toHaveLength(10);
    // One batch per source; no per-item findUnique.
    const batchCalls = findMany.mock.calls.filter(([args]) => {
      const where = (args as { where?: { link?: { in?: string[] } } }).where;
      return where?.link?.in !== undefined;
    });
    expect(batchCalls).toHaveLength(3);
    for (const [args] of batchCalls) {
      expect((args as { where: { link: { in: string[] } } }).where.link.in).toHaveLength(12);
    }
    expect(findUnique).not.toHaveBeenCalled();
    // No image was found and description/category were complete: no writes.
    expect(update).not.toHaveBeenCalled();
  });

  it('fetches each new article page exactly once, prefers the feed image and records provenance', async () => {
    const linkA = `${ARTICLE_PREFIX}10`;
    const linkB = `${ARTICLE_PREFIX}11`;
    const feedParagraphB = 'B'.repeat(60);

    mockHttp((url) => {
      if (url === linkA) {
        return `<html><head><meta property="og:image" content="https://example.com/page-image.jpg"></head>
          <body><div class="entry-content"><p>Page paragraph A.</p></div></body></html>`;
      }
      if (url === linkB) return '<html><head></head><body></body></html>';
      return baseRoutes({
        [FEED_URLS[0]]: [
          {
            link: linkA,
            title: 'New Article A',
            content: '<p>Feed paragraph A.</p><img src="https://example.com/feed-image.jpg">',
            categories: ['Politics'],
          },
          {
            link: linkB,
            title: 'New Article B',
            content: `<p>${feedParagraphB}</p>`,
            categories: ['News'],
          },
        ],
      })(url);
    });

    const { upsert } = await articleMocks();

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion({ skipImageBackfill: true });

    expect(upsert).toHaveBeenCalledTimes(2);
    const creates = upsert.mock.calls.map(([args]) => (args as { create: Record<string, unknown> }).create);
    const createA = creates.find((create) => create.link === linkA);
    const createB = creates.find((create) => create.link === linkB);

    // Feed image wins over the page og:image; page paragraph wins over feed HTML.
    expect(createA?.imageUrl).toBe('https://example.com/feed-image.jpg');
    expect(createA?.paragraphs).toEqual(['Page paragraph A.']);
    expect(createA?.contentSource).toBe('page');
    expect(createA?.contentAttempts).toBe(0);
    expect(createA?.lastContentAttemptAt).toBeNull();
    // No feed image -> page og:image; no selector paragraphs -> feed HTML fallback.
    expect(createB?.imageUrl).toBeNull();
    expect(createB?.paragraphs).toEqual([feedParagraphB]);
    expect(createB?.contentSource).toBe('feed');
    expect(createB?.contentAttempts).toBe(0);
    // Date provenance is persisted with the raw publisher value.
    expect(createA?.pubDateSource).toBe('published');
    expect(createA?.pubDateRaw).toBe(DEFAULT_FEED_DATE);

    // Exactly one page fetch per new article, no duplicate content+image requests.
    expect(articlePageCalls().filter((url) => url === linkA)).toHaveLength(1);
    expect(articlePageCalls().filter((url) => url === linkB)).toHaveLength(1);
  });

  it('stores an undated feed item with missing provenance instead of throwing', async () => {
    const link = `${ARTICLE_PREFIX}20`;
    mockHttp((url) => {
      if (url === link) return '<html><head></head><body></body></html>';
      return baseRoutes({
        [FEED_URLS[0]]: [{ link, title: 'Undated Article', pubDate: '', content: '<p>Feed body paragraph.</p>' }],
      })(url);
    });

    const { upsert } = await articleMocks();
    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await expect(runSierraLeoneIngestion({ skipImageBackfill: true })).resolves.toBeUndefined();

    expect(upsert).toHaveBeenCalledTimes(1);
    const create = (upsert.mock.calls[0][0] as { create: Record<string, unknown> }).create;
    expect(create.pubDateSource).toBe('missing');
    expect(create.pubDateRaw).toBeNull();
    expect((create.pubDate as Date).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('keeps the raw unparseable date and marks provenance missing', async () => {
    const link = `${ARTICLE_PREFIX}21`;
    mockHttp((url) => {
      if (url === link) return '<html><head></head><body></body></html>';
      return baseRoutes({
        [FEED_URLS[0]]: [{ link, title: 'Bad Date Article', pubDate: 'not-a-date', content: '<p>Feed body.</p>' }],
      })(url);
    });

    const { upsert } = await articleMocks();
    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion({ skipImageBackfill: true });

    const create = (upsert.mock.calls[0][0] as { create: Record<string, unknown> }).create;
    expect(create.pubDateSource).toBe('missing');
    expect(create.pubDateRaw).toBe('not-a-date');
  });

  it('clamps a wildly future date to now and keeps the raw value', async () => {
    const link = `${ARTICLE_PREFIX}22`;
    const future = 'Tue, 01 Jan 2098 00:00:00 GMT';
    mockHttp((url) => {
      if (url === link) return '<html><head></head><body></body></html>';
      return baseRoutes({
        [FEED_URLS[0]]: [{ link, title: 'Future Dated', pubDate: future, content: '<p>Feed body.</p>' }],
      })(url);
    });

    const { upsert } = await articleMocks();
    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion({ skipImageBackfill: true });

    const create = (upsert.mock.calls[0][0] as { create: Record<string, unknown> }).create;
    expect(create.pubDateSource).toBe('clamped');
    expect(create.pubDateRaw).toBe(future);
    expect((create.pubDate as Date).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect((create.pubDate as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('repairs empty content inline from the feed pass', async () => {
    const link = `${ARTICLE_PREFIX}30`;
    mockHttp((url) => {
      if (url === link) {
        return '<html><body><div class="entry-content"><p>Repaired paragraph after fetch.</p></div></body></html>';
      }
      return baseRoutes({ [FEED_URLS[0]]: [{ link, title: 'Empty Content Article' }] })(url);
    });

    const { findMany, update, upsert } = await articleMocks();
    const row = existingRow({
      id: 30,
      link,
      paragraphs: [],
      contentSource: 'empty',
      contentAttempts: 1,
    });
    findMany.mockImplementation(findManyRouting({ rows: (links) => (links.includes(link) ? [row] : []) }));

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion({ skipImageBackfill: true });

    // The feed "summary" body is not used; the page body is stored and attempts reset.
    expect(upsert).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 30 },
        data: expect.objectContaining({
          paragraphs: ['Repaired paragraph after fetch.'],
          contentSource: 'page',
          contentAttempts: 0,
          lastContentAttemptAt: expect.any(Date),
        }),
      }),
    );
    expect(articlePageCalls().filter((url) => url === link)).toHaveLength(1);
  });

  it('caps the repair sweep at 5 and increments attempts when the page has no body', async () => {
    const candidates = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      link: `${REPAIR_PREFIX}${i}`,
      source: 'Politico SL',
    }));
    mockHttp((url) => {
      if (url.startsWith(REPAIR_PREFIX)) return '<html><body><p>No matching selector here.</p></body></html>';
      return baseRoutes({})(url);
    });

    const { findMany, update } = await articleMocks();
    findMany.mockImplementation(findManyRouting({ repairCandidates: candidates }));

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion({ skipImageBackfill: true });

    expect(findMany).toHaveBeenCalledWith(REPAIR_SWEEP_QUERY);
    expect(httpCalls().filter((url) => url.startsWith(REPAIR_PREFIX))).toHaveLength(5);
    expect(update).toHaveBeenCalledTimes(5);
    for (const [args] of update.mock.calls) {
      expect(args).toEqual(
        expect.objectContaining({
          data: {
            contentSource: 'empty',
            contentAttempts: { increment: 1 },
            lastContentAttemptAt: expect.any(Date),
          },
        }),
      );
    }
    // The sixth candidate waits for a later run (shared per-run repair cap).
    expect(httpCalls()).not.toContain(`${REPAIR_PREFIX}5`);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ repaired: 5 }),
      'Content repair budget exhausted; remaining rows wait for a later run',
    );
  });

  it('marks a successful sweep repair as page content with attempts reset', async () => {
    const candidate = { id: 77, link: `${REPAIR_PREFIX}success`, source: 'The Sierra Leone Telegraph' };
    mockHttp((url) => {
      if (url === candidate.link) {
        return '<html><body><div class="entry-content"><p>Sweep repaired body paragraph.</p></div></body></html>';
      }
      return baseRoutes({})(url);
    });

    const { findMany, update } = await articleMocks();
    findMany.mockImplementation(findManyRouting({ repairCandidates: [candidate] }));

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion({ skipImageBackfill: true });

    expect(update).toHaveBeenCalledWith({
      where: { id: 77 },
      data: {
        paragraphs: ['Sweep repaired body paragraph.'],
        contentSource: 'page',
        contentAttempts: 0,
        lastContentAttemptAt: expect.any(Date),
      },
    });
  });

  it('stores an empty sitemap body instead of fabricating one, with date provenance', async () => {
    const pageHtml = `<html><head>
      <meta property="og:title" content="Sitemap Story">
      <meta property="og:description" content="Meta description from og.">
      <meta property="article:published_time" content="2026-09-01T10:00:00Z">
      </head><body><p>Too short to be a paragraph.</p></body></html>`;

    mockHttp((url) => {
      if (url === TELEGRAPH_SITEMAP_PAGE(1)) return sitemapXml([SITEMAP_STORY]);
      if (url === SITEMAP_STORY) return pageHtml;
      return baseRoutes({})(url);
    });

    const { findMany, upsert } = await articleMocks();
    findMany.mockImplementation(findManyRouting({}));

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion({ skipImageBackfill: true });

    expect(upsert).toHaveBeenCalledTimes(1);
    const create = (upsert.mock.calls[0][0] as { create: Record<string, unknown> }).create;
    // No fabricated body from the description/title.
    expect(create.paragraphs).toEqual([]);
    expect(create.contentSource).toBe('empty');
    expect(create.contentAttempts).toBe(1);
    expect(create.lastContentAttemptAt).toBeInstanceOf(Date);
    // Description still comes from og/meta.
    expect(create.description).toBe('Meta description from og.');
    // Page date parsed with provenance.
    expect(create.pubDateSource).toBe('published');
    expect(create.pubDateRaw).toBe('2026-09-01T10:00:00Z');
    expect(create.pubDate).toEqual(new Date('2026-09-01T10:00:00Z'));
  });

  it('stops the sitemap walk after two consecutive fully-known pages', async () => {
    const known = ['a', 'b', 'c', 'd'].map((slug) => `${ARTICLE_PREFIX}${slug}`);
    mockHttp((url) => {
      if (url === TELEGRAPH_SITEMAP_PAGE(1)) return sitemapXml([known[0], known[1]]);
      if (url === TELEGRAPH_SITEMAP_PAGE(2)) return sitemapXml([known[2], known[3]]);
      if (url === TELEGRAPH_SITEMAP_PAGE(3)) return sitemapXml([`${ARTICLE_PREFIX}unknown`]);
      return baseRoutes({})(url);
    });

    const { findMany, upsert } = await articleMocks();
    findMany.mockImplementation(findManyRouting({ knownLinks: known }));

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion({ skipImageBackfill: true });

    // Pages 1 and 2 are fully known -> stop before touching page 3.
    expect(httpCalls().filter((url) => url === TELEGRAPH_SITEMAP_PAGE(1))).toHaveLength(1);
    expect(httpCalls().filter((url) => url === TELEGRAPH_SITEMAP_PAGE(2))).toHaveLength(1);
    expect(httpCalls()).not.toContain(TELEGRAPH_SITEMAP_PAGE(3));
    expect(upsert).not.toHaveBeenCalled();
  });

  it('treats a 404 sitemap page as the normal end of the sitemap', async () => {
    mockHttp(baseRoutes({}));

    const { findMany, upsert } = await articleMocks();
    findMany.mockImplementation(findManyRouting({}));

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion({ skipImageBackfill: true });

    expect(httpCalls().filter((url) => url === TELEGRAPH_SITEMAP_PAGE(1))).toHaveLength(1);
    expect(httpCalls()).not.toContain(TELEGRAPH_SITEMAP_PAGE(2));
    expect(upsert).not.toHaveBeenCalled();
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, status: 404 }),
      'Sitemap end reached (404/410)',
    );
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });

  it('logs an error and stops on non-404 sitemap failures', async () => {
    mockHttp((url) => {
      if (url === TELEGRAPH_SITEMAP_PAGE(1)) return httpError(500);
      return baseRoutes({})(url);
    });

    const { findMany } = await articleMocks();
    findMany.mockImplementation(findManyRouting({}));

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion({ skipImageBackfill: true });

    expect(httpCalls().filter((url) => url === TELEGRAPH_SITEMAP_PAGE(1))).toHaveLength(3); // retried
    expect(httpCalls()).not.toContain(TELEGRAPH_SITEMAP_PAGE(2));
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1 }),
      'Sitemap page fetch failed; stopping sitemap walk',
    );
  });

  it('does no HTTP work when the run deadline has already passed', async () => {
    mockHttp(baseRoutes({}));

    const { findMany, findUnique, videoFindMany } = await articleMocks();
    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion({ deadlineAt: Date.now() - 1000, skipImageBackfill: true });

    expect(axios.get).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(videoFindMany).not.toHaveBeenCalled();
  });

  it('retries a failing feed through the HTTP path before parsing it', async () => {
    const link = `${ARTICLE_PREFIX}12`;
    let feedAttempts = 0;

    mockHttp((url) => {
      if (url === FEED_URLS[0]) {
        feedAttempts++;
        return feedAttempts === 1 ? httpError(500) : rssXml([{ link, title: 'Retried Article' }]);
      }
      if (url === link) return '<html><head></head><body></body></html>';
      return baseRoutes({})(url);
    });

    const { upsert } = await articleMocks();
    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion({ skipImageBackfill: true });

    expect(feedAttempts).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('resolves when a feed fails', async () => {
    mockHttp((url) => (FEED_URLS.includes(url) ? new Error('network error') : baseRoutes({})(url)));

    const { upsert } = await articleMocks();
    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await expect(runSierraLeoneIngestion({ skipImageBackfill: true })).resolves.toBeUndefined();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('handles individual article ingestion errors without aborting the run', async () => {
    const link = `${ARTICLE_PREFIX}13`;
    const feedParagraph = 'C'.repeat(60);

    mockHttp((url) => {
      if (url === link) return new Error('network error');
      return baseRoutes({
        [FEED_URLS[0]]: [{ link, title: 'Bad Article', content: `<p>${feedParagraph}</p>` }],
      })(url);
    });

    const { upsert } = await articleMocks();
    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await expect(runSierraLeoneIngestion({ skipImageBackfill: true })).resolves.not.toThrow();

    // Page fetch failed but the feed-HTML fallback still produces an article.
    expect(upsert).toHaveBeenCalledTimes(1);
    const create = (upsert.mock.calls[0][0] as { create: Record<string, unknown> }).create;
    expect(create.paragraphs).toEqual([feedParagraph]);
    expect(create.contentSource).toBe('feed');
  });
});

describe('parseSitemapUrls', () => {
  it('extracts loc URLs from sitemap XML', async () => {
    const { parseSitemapUrls } = await import('../services/scraper.js');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/a</loc></url>
        <url><loc>https://example.com/b</loc></url>
        <url><loc>   </loc></url>
      </urlset>`;
    expect(parseSitemapUrls(xml)).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('returns an empty array for XML without URLs', async () => {
    const { parseSitemapUrls } = await import('../services/scraper.js');
    expect(parseSitemapUrls('<urlset></urlset>')).toEqual([]);
  });
});
