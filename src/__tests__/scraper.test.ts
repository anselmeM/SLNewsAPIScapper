import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({
  prisma: {
    article: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({ id: 1 }),
      upsert: vi.fn().mockResolvedValue({ id: 1 }),
    },
    video: {
      findUnique: vi.fn().mockResolvedValue(null),
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

const TELEGRAPH_FEED = 'https://www.thesierraleonetelegraph.com/feed/';

const ARTICLE_PAGE_PREFIX = 'https://example.com/article-';

/** Only the first source returns items; the other two feeds are empty. */
async function mockFirstSourceFeed(items: unknown[]) {
  const Parser = (await import('rss-parser')).default;
  vi.spyOn(Parser.prototype, 'parseURL').mockImplementation((async (url: string) => {
    return url === TELEGRAPH_FEED ? { items } : { items: [] };
  }) as never);
}

/** Every source returns the same items (used to prove caps span sources). */
async function mockEverySourceFeed(items: unknown[]) {
  const Parser = (await import('rss-parser')).default;
  vi.spyOn(Parser.prototype, 'parseURL').mockImplementation((async () => ({ items })) as never);
}

function articlePageFetches(axiosGet: ReturnType<typeof vi.fn>) {
  return axiosGet.mock.calls.filter(([url]) => String(url).startsWith(ARTICLE_PAGE_PREFIX));
}

beforeEach(async () => {
  vi.restoreAllMocks();

  const axios = (await import('axios')).default;
  const axiosGet = axios.get as ReturnType<typeof vi.fn>;
  axiosGet.mockReset();
  axiosGet.mockRejectedValue(new Error('network error'));

  const { prisma } = await import('../db.js');
  const articleFindMany = prisma.article.findMany as ReturnType<typeof vi.fn>;
  const articleFindUnique = prisma.article.findUnique as ReturnType<typeof vi.fn>;
  const articleUpdate = prisma.article.update as ReturnType<typeof vi.fn>;
  const articleUpsert = prisma.article.upsert as ReturnType<typeof vi.fn>;
  articleFindMany.mockReset().mockResolvedValue([]);
  articleFindUnique.mockReset().mockResolvedValue(null);
  articleUpdate.mockReset().mockResolvedValue({ id: 1 });
  articleUpsert.mockReset().mockResolvedValue({ id: 1 });

  const videoFindUnique = prisma.video.findUnique as ReturnType<typeof vi.fn>;
  const videoUpsert = prisma.video.upsert as ReturnType<typeof vi.fn>;
  videoFindUnique.mockReset().mockResolvedValue(null);
  videoUpsert.mockReset().mockResolvedValue({ id: 1 });
});

describe('runSierraLeoneIngestion', () => {
  it('fills missing image, description and category on an existing article from the feed item', async () => {
    await mockFirstSourceFeed([
      {
        link: 'https://example.com/article-1',
        title: 'Existing Article',
        pubDate: '2025-01-01',
        contentSnippet: 'Fresh description from the feed.',
        content: '<p>Body text.</p><img src="https://example.com/thumb.jpg">',
        categories: ['Politics'],
      },
    ]);

    const { prisma } = await import('../db.js');
    const findUnique = prisma.article.findUnique as ReturnType<typeof vi.fn>;
    const update = prisma.article.update as ReturnType<typeof vi.fn>;
    const upsert = prisma.article.upsert as ReturnType<typeof vi.fn>;

    findUnique.mockResolvedValue({
      id: 7,
      link: 'https://example.com/article-1',
      imageUrl: null,
      description: null,
      category: [],
    });

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion();

    // One update per existing article, only with the fields that were missing.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: {
        imageUrl: 'https://example.com/thumb.jpg',
        description: 'Fresh description from the feed.',
        category: ['Politics'],
      },
    });
    // Backfill never creates articles; the upsert path is for new links only.
    expect(upsert).not.toHaveBeenCalled();

    // Image came from the feed HTML, so no article page network fetch was needed.
    const axios = (await import('axios')).default;
    expect(articlePageFetches(axios.get as ReturnType<typeof vi.fn>)).toHaveLength(0);
  });

  it('does not overwrite existing complete metadata', async () => {
    await mockFirstSourceFeed([
      {
        link: 'https://example.com/article-2',
        title: 'Complete Article',
        pubDate: '2025-01-01',
        contentSnippet: 'Feed description that must not win.',
        content: '<p>Body</p><img src="https://example.com/feed-image.jpg">',
        categories: ['Politics'],
      },
    ]);

    const { prisma } = await import('../db.js');
    const findUnique = prisma.article.findUnique as ReturnType<typeof vi.fn>;
    const update = prisma.article.update as ReturnType<typeof vi.fn>;

    findUnique.mockResolvedValue({
      id: 11,
      link: 'https://example.com/article-2',
      imageUrl: 'https://example.com/existing.jpg',
      description: 'Existing description',
      category: ['Old Category'],
    });

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion();

    expect(update).not.toHaveBeenCalled();
    expect(articlePageFetches((await import('axios')).default.get as ReturnType<typeof vi.fn>)).toHaveLength(0);
  });

  it('caps article-page image fetches at 10 across all feeds in one run', async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      link: `${ARTICLE_PAGE_PREFIX}${i}`,
      title: `Article ${i}`,
      pubDate: '2025-01-01',
      content: '<p>Feed content without any images.</p>',
      contentSnippet: 'Feed snippet.',
      categories: ['News'],
    }));

    // All three feeds return these 12 items: 36 backfill candidates in one run,
    // so the cap has to be shared across sources rather than per source.
    await mockEverySourceFeed(items);

    const { prisma } = await import('../db.js');
    const findUnique = prisma.article.findUnique as ReturnType<typeof vi.fn>;
    findUnique.mockImplementation(({ where }: { where: { link: string } }) =>
      Promise.resolve({
        id: 1,
        link: where.link,
        imageUrl: null,
        description: 'Existing description',
        category: ['News'],
      }),
    );

    const axios = (await import('axios')).default;
    const axiosGet = axios.get as ReturnType<typeof vi.fn>;
    // Article pages resolve, but contain no og:image, so every attempt is a
    // successful single axios request and the fetch count equals attempt count.
    axiosGet.mockResolvedValue({ data: '<html><head></head><body></body></html>' });

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion();

    expect(articlePageFetches(axiosGet)).toHaveLength(10);
  });

  it('resolves when a feed fails', async () => {
    const Parser = (await import('rss-parser')).default;
    vi.spyOn(Parser.prototype, 'parseURL').mockRejectedValue(new Error('network error'));

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await expect(runSierraLeoneIngestion()).resolves.toBeUndefined();
  });

  it('handles individual article ingestion errors', async () => {
    const Parser = (await import('rss-parser')).default;
    vi.spyOn(Parser.prototype, 'parseURL').mockResolvedValue({
      items: [
        {
          link: 'https://example.com/bad-article',
          title: 'Bad Article',
          pubDate: 'invalid-date',
          content: '<p>Content</p>',
        },
      ],
    } as never);

    const { prisma } = await import('../db.js');
    (prisma.article.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await expect(runSierraLeoneIngestion()).resolves.not.toThrow();
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
