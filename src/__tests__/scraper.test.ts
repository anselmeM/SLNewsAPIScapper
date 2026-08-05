import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', () => ({
  prisma: {
    article: {
      count: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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
    get: vi.fn().mockRejectedValue(new Error('network error')),
  },
}));

const mockFeed = {
  items: [
    {
      link: 'https://example.com/article-1',
      title: 'Test Article',
      pubDate: '2025-01-01',
      creator: 'Test Author',
      content: '<p>Content paragraph.</p>',
      contentSnippet: 'Short description.',
      categories: ['Politics'],
    },
  ],
};

describe('runSierraLeoneIngestion', () => {
  it('skips articles that already exist', async () => {
    const Parser = (await import('rss-parser')).default;
    vi.spyOn(Parser.prototype, 'parseURL').mockResolvedValue(mockFeed as never);

    const { prisma } = await import('../db.js');
    (prisma.article.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.article.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1,
      link: 'https://example.com/article-1',
    });

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await runSierraLeoneIngestion();

    expect(prisma.article.create).not.toHaveBeenCalled();
  });

  it('handles feed parsing errors gracefully', async () => {
    const Parser = (await import('rss-parser')).default;
    vi.spyOn(Parser.prototype, 'parseURL').mockRejectedValue(new Error('network error'));

    const { prisma } = await import('../db.js');
    (prisma.article.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const { runSierraLeoneIngestion } = await import('../services/scraper.js');
    await expect(runSierraLeoneIngestion()).resolves.not.toThrow();
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
    (prisma.article.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
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
