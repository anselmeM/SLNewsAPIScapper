import Parser from 'rss-parser';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { prisma } from '../db.js';
import { SIERRA_LEONE_SOURCES, NewsSourceConfig } from '../config/sources.js';
import logger from '../logger.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const parser = new Parser({
  headers: { 'User-Agent': USER_AGENT },
});

interface FeedItem {
  link?: string;
  title?: string;
  pubDate?: string;
  creator?: string;
  content?: string;
  contentSnippet?: string;
  description?: string;
  categories?: string[];
  [key: string]: unknown;
}

function safeParseDate(dateStr?: string): Date {
  if (!dateStr) return new Date();
  let d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d;

  const cleaned = dateStr
    .replace(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s*/i, '')
    .replace(/\s*-\s*(\d{1,2}:\d{2})/, ' $1');
  d = new Date(cleaned);
  if (!isNaN(d.getTime())) return d;

  return new Date();
}

function extractRealLink(rawLink: string): string {
  if (!rawLink.includes('%3C') && !rawLink.includes('<')) return rawLink;
  try {
    const decoded = decodeURIComponent(rawLink);
    const match = decoded.match(/href="([^"]+)"/);
    if (match) {
      const href = match[1];
      if (href.startsWith('/')) {
        return new URL(rawLink).origin + href;
      }
      return href;
    }
  } catch {
    // fall through to raw link
  }
  return rawLink;
}

function paragraphsFromHtml(html: string): string[] {
  const $ = cheerio.load(html);
  const paragraphs: string[] = [];
  $('p').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length > 40) paragraphs.push(text);
  });
  return paragraphs;
}

function firstImageFromHtml(html: string): string | null {
  const $ = cheerio.load(html);
  const src = $('img').first().attr('src');
  return src || null;
}

function getFeedContentHtml(item: FeedItem): string {
  const encoded = item['content:encoded'];
  if (typeof encoded === 'string') return encoded;
  if (item.content) return item.content;
  if (item.description) return item.description;
  return '';
}

function extractDescription(item: FeedItem): string | null {
  if (item.contentSnippet) {
    const trimmed = item.contentSnippet.trim();
    if (trimmed.length > 0) return trimmed.slice(0, 500);
  }
  if (item.description) {
    const stripped = item.description.replace(/<[^>]*>/g, '').trim();
    if (stripped.length > 0) return stripped.slice(0, 500);
  }
  return null;
}

async function findArticleImage(link: string, feedHtml: string): Promise<string | null> {
  if (feedHtml) {
    const src = firstImageFromHtml(feedHtml);
    if (src) {
      if (src.startsWith('http')) return src;
      try {
        return new URL(src, link).href;
      } catch {}
    }
  }

  try {
    const { data } = await axios.get(link, {
      timeout: 8000,
      headers: { 'User-Agent': USER_AGENT },
    });
    const $ = cheerio.load(data);
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) {
      if (ogImage.startsWith('http')) return ogImage;
      try {
        return new URL(ogImage, link).href;
      } catch {}
    }
  } catch {
    logger.warn({ link }, 'Failed to fetch article page for image');
  }

  return null;
}

async function scrapeFullContent(url: string, selector: string): Promise<string[]> {
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': USER_AGENT },
    });
    const $ = cheerio.load(data);
    const paragraphs: string[] = [];

    $(selector).each((_, el) => {
      const text = $(el).text().trim();
      if (text) paragraphs.push(text);
    });

    return paragraphs;
  } catch (err) {
    logger.warn({ url, err }, 'Failed to parse content');
    return [];
  }
}

async function backfillArticleMeta(): Promise<void> {
  const counts = await prisma.article.count({
    where: { OR: [{ imageUrl: null }, { description: null }, { category: { equals: [] } }] },
  });
  if (counts === 0) return;

  logger.info({ count: counts }, 'Backfilling articles with missing metadata');

  const allArticles = await prisma.article.findMany({
    select: { id: true, link: true, imageUrl: true, description: true, category: true },
  });
  const linkMap = new Map(allArticles.map((a) => [a.link, a]));

  for (const source of SIERRA_LEONE_SOURCES) {
    try {
      const feed = await parser.parseURL(source.feedUrl);
      for (const item of feed.items) {
        if (!item.link) continue;
        const link = extractRealLink(item.link);
        const existing = linkMap.get(link);
        if (!existing) continue;

        const updateData: Record<string, unknown> = {};

        if (!existing.imageUrl) {
          const feedHtml = getFeedContentHtml(item);
          const img = await findArticleImage(link, feedHtml);
          if (img) updateData.imageUrl = img;
        }

        if (!existing.description) {
          const desc = extractDescription(item);
          if (desc) updateData.description = desc;
        }

        if (existing.category.length === 0 && item.categories && item.categories.length > 0) {
          updateData.category = item.categories;
        }

        if (Object.keys(updateData).length > 0) {
          await prisma.article.update({ where: { id: existing.id }, data: updateData });
          logger.trace({ id: existing.id, title: item.title?.slice(0, 50) }, 'Backfilled article meta');
        }
      }
    } catch {
      logger.warn({ source: source.name }, 'Failed backfilling from feed');
    }
  }
}

export async function runSierraLeoneIngestion() {
  logger.info('Starting Sierra Leone Ingestion Cycle');

  await backfillArticleMeta();

  for (const source of SIERRA_LEONE_SOURCES) {
    logger.info({ source: source.name }, 'Checking feed');

    try {
      const feed = await parser.parseURL(source.feedUrl);

      for (const item of feed.items) {
        if (!item.link || !item.title) continue;

        try {
          const link = extractRealLink(item.link);

          const existing = await prisma.article.findUnique({
            where: { link },
          });

          if (!existing) {
            logger.info({ title: item.title }, 'Ingesting article');
            let paragraphs = await scrapeFullContent(link, source.contentSelector);

            const feedHtml = getFeedContentHtml(item);

            if (paragraphs.length === 0 && feedHtml) {
              paragraphs = paragraphsFromHtml(feedHtml);
            }

            const imageUrl = await findArticleImage(link, feedHtml);
            const description = extractDescription(item);

            await prisma.article.create({
              data: {
                title: item.title,
                link: link,
                pubDate: safeParseDate(item.pubDate),
                author: item.creator || source.name,
                description: description,
                category: item.categories || [],
                imageUrl: imageUrl,
                paragraphs: paragraphs,
                source: source.name,
              },
            });

            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } catch (itemError) {
          logger.warn({ title: item.title, error: itemError }, 'Error ingesting article');
        }
      }
    } catch (feedError) {
      logger.error({ source: source.name, error: feedError }, 'Error reading feed');
    }
  }

  logger.info('Ingestion Cycle Complete');

  // Sitemap fallback: catch articles the RSS feed may have missed
  await scrapeTelegraphFromSitemap();
}

/**
 * Scrape the WordPress sitemap for article URLs that may have been missed by the RSS feed.
 * The Telegraph RSS only returns ~10 items. The sitemap has the full archive.
 */
async function scrapeTelegraphFromSitemap(): Promise<void> {
  try {
    // Parse the sitemap index
    const indexResp = await axios.get('https://www.thesierraleonetelegraph.com/wp-sitemap-posts-post-1.xml', {
      timeout: 15000,
      headers: { 'User-Agent': USER_AGENT },
    });
    const $ = cheerio.load(indexResp.data, { xmlMode: true });
    const urls: string[] = [];
    $('url loc').each((_, el) => {
      const url = $(el).text().trim();
      if (url) urls.push(url);
    });

    if (urls.length === 0) {
      logger.warn('Sitemap scrape returned no URLs');
      return;
    }

    logger.info({ totalUrls: urls.length }, 'Sitemap scrape found URLs');

    // Check each URL against existing articles, ingest if new
    let ingested = 0;
    for (const url of urls.slice(0, 50)) { // Limit to 50 per run
      const existing = await prisma.article.findUnique({ where: { link: url } });
      if (existing) continue;

      try {
        const pageResp = await axios.get(url, {
          timeout: 10000,
          headers: { 'User-Agent': USER_AGENT },
        });
        const page$ = cheerio.load(pageResp.data);
        const title = page$('meta[property="og:title"]').attr('content')
          || page$('title').text().trim() || 'Untitled';
        const description = page$('meta[property="og:description"]').attr('content')
          || page$('meta[name="description"]').attr('content') || '';
        const imageUrl = page$('meta[property="og:image"]').attr('content') || null;
        const author = page$('meta[property="article:author"]').attr('content')
          || page$('.entry-author a').text().trim() || 'The Sierra Leone Telegraph';
        const pubDateStr = page$('meta[property="article:published_time"]').attr('content')
          || page$('time.entry-date').attr('datetime') || '';
        const paragraphs: string[] = [];
        page$('.entry-content p, .entry-content h2').each((_, el) => {
          const text = page$(el).text().trim();
          if (text && text.length > 40) paragraphs.push(text);
        });

        await prisma.article.create({
          data: {
            title: title.slice(0, 500),
            link: url,
            pubDate: pubDateStr ? new Date(pubDateStr) : new Date(),
            author: author.slice(0, 200),
            description: description.slice(0, 500),
            category: [],
            imageUrl,
            paragraphs: paragraphs.length > 0 ? paragraphs : [description.slice(0, 500) || title],
            source: 'The Sierra Leone Telegraph',
          },
        });
        ingested++;
        await new Promise((resolve) => setTimeout(resolve, 1500)); // Rate limit
      } catch (itemErr) {
        logger.warn({ url, error: itemErr }, 'Sitemap item scrape failed');
      }
    }

    logger.info({ ingested, total: urls.length }, 'Sitemap scrape complete');
  } catch (err) {
    logger.error({ err }, 'Sitemap scrape failed');
  }
}
