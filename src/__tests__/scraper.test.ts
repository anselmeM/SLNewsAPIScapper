import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import logger from '../logger.js';

vi.mock('../db.js', () => ({
  prisma: {
    article: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({ id: 1 }),
      upsert: vi.fn().mockResolvedValue({ id: 1 }),
    },
    video: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({ id: 1 }),
    },
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
const YOUTUBE_FEED_PREFIX = 'https://www.youtube.com/feeds/videos.xml?channel_id=';

const EMPTY_ATOM_FEED =
  '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Empty</title></feed>';

type Mock = ReturnType<typeof vi.fn>;

interface TestFeedItem {
  link: string;
  title: string;
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
    .map(
      (item) => `
    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <pubDate>${escapeXml(item.pubDate ?? 'Fri, 09 Oct 2026 12:00:00 GMT')}</pubDate>
      ${item.content ? `<description><![CDATA[${item.content}]]></description>` : ''}
      ${(item.categories ?? []).map((category) => `<category>${escapeXml(category)}</category>`).join('')}
    </item>`,
    )
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
    findMany.mockImplementation((args: { where?: { source?: string; link?: { in?: string[] } } }) => {
      if (args.where?.source) return Promise.resolve([]);
      const links = args.where?.link?.in ?? [];
      return Promise.resolve(
        [{ id: 7, link, imageUrl: null, description: null, category: [] }].filter((row) => links.includes(row.link)),
      );
    });

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion();

    // Batched dedupe: one findMany for the source, no per-item findUnique.
    expect(findMany).toHaveBeenCalledWith({
      where: { link: { in: [link] } },
      select: { id: true, link: true, imageUrl: true, description: true, category: true },
    });
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
    // Feeds now go through the retry path (axios) instead of rss-parser.parseURL.
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
    findMany.mockImplementation((args: { where?: { source?: string; link?: { in?: string[] } } }) => {
      if (args.where?.source) return Promise.resolve([]);
      const links = args.where?.link?.in ?? [];
      return Promise.resolve(
        [
          {
            id: 11,
            link,
            imageUrl: 'https://example.com/existing.jpg',
            description: 'Existing description',
            category: ['Old Category'],
          },
        ].filter((row) => links.includes(row.link)),
      );
    });

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion();

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
    const feeds = Object.fromEntries(FEED_URLS.map((url) => [url, items]));

    mockHttp((url) => {
      if (url.startsWith(ARTICLE_PREFIX)) return '<html><head></head><body></body></html>';
      return baseRoutes(feeds)(url);
    });

    const { findMany, findUnique, update } = await articleMocks();
    findMany.mockImplementation((args: { where?: { source?: string; link?: { in?: string[] } } }) => {
      if (args.where?.source) return Promise.resolve([]);
      const links = args.where?.link?.in ?? [];
      return Promise.resolve(
        links.map((link, index) => ({
          id: index + 1,
          link,
          imageUrl: null,
          description: 'Existing description',
          category: ['News'],
        })),
      );
    });

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion();

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

  it('fetches each new article page exactly once and prefers the feed image', async () => {
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
    await runSierraLeoneIngestion();

    expect(upsert).toHaveBeenCalledTimes(2);
    const creates = upsert.mock.calls.map(([args]) => (args as { create: Record<string, unknown> }).create);
    const createA = creates.find((create) => create.link === linkA);
    const createB = creates.find((create) => create.link === linkB);

    // Feed image wins over the page og:image; page paragraph wins over feed HTML.
    expect(createA?.imageUrl).toBe('https://example.com/feed-image.jpg');
    expect(createA?.paragraphs).toEqual(['Page paragraph A.']);
    // No feed image -> page og:image; no selector paragraphs -> feed HTML fallback.
    expect(createB?.imageUrl).toBeNull();
    expect(createB?.paragraphs).toEqual([feedParagraphB]);

    // Exactly one page fetch per new article, no duplicate content+image requests.
    expect(articlePageCalls().filter((url) => url === linkA)).toHaveLength(1);
    expect(articlePageCalls().filter((url) => url === linkB)).toHaveLength(1);
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
    findMany.mockImplementation((args: { where?: { source?: string } }) => {
      if (args.where?.source) return Promise.resolve(known.map((link) => ({ link })));
      return Promise.resolve([]);
    });

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion();

    // Pages 1 and 2 are fully known -> stop before touching page 3.
    expect(httpCalls().filter((url) => url === TELEGRAPH_SITEMAP_PAGE(1))).toHaveLength(1);
    expect(httpCalls().filter((url) => url === TELEGRAPH_SITEMAP_PAGE(2))).toHaveLength(1);
    expect(httpCalls()).not.toContain(TELEGRAPH_SITEMAP_PAGE(3));
    expect(upsert).not.toHaveBeenCalled();
  });

  it('treats a 404 sitemap page as the normal end of the sitemap', async () => {
    mockHttp(baseRoutes({}));

    const { findMany, upsert } = await articleMocks();
    findMany.mockImplementation((args: { where?: { source?: string } }) => {
      if (args.where?.source) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion();

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
    findMany.mockImplementation((args: { where?: { source?: string } }) => {
      if (args.where?.source) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion();

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
    await runSierraLeoneIngestion({ deadlineAt: Date.now() - 1000 });

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
    await runSierraLeoneIngestion();

    expect(feedAttempts).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('resolves when a feed fails', async () => {
    mockHttp((url) => (FEED_URLS.includes(url) ? new Error('network error') : baseRoutes({})(url)));

    const { upsert } = await articleMocks();
    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await expect(runSierraLeoneIngestion()).resolves.toBeUndefined();
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
    await expect(runSierraLeoneIngestion()).resolves.not.toThrow();

    // Page fetch failed but the feed-HTML fallback still produces an article.
    expect(upsert).toHaveBeenCalledTimes(1);
    const create = (upsert.mock.calls[0][0] as { create: Record<string, unknown> }).create;
    expect(create.paragraphs).toEqual([feedParagraph]);
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
