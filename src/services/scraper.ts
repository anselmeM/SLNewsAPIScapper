import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import { prisma } from '../db.js';
import { SIERRA_LEONE_SOURCES } from '../config/sources.js';
import { runSierraLeoneVideoIngestion } from './video-scraper.js';
import { normalizeArticleUrl } from '../utils/url.js';
import { fetchWithRetry, USER_AGENT, sleep } from '../utils/http.js';
import logger from '../logger.js';

const parser = new Parser();

// Metadata backfill (image/description/category) runs inline with each feed
// item we already parsed. Image backfill can still hit an article page, so it is
// capped per ingestion run to keep a run bounded even if many rows are missing
// images forever.
const MAX_IMAGE_FETCHES_PER_RUN = 10;
const BACKFILL_BUDGET_MS = 60_000;

const FEED_TIMEOUT_MS = 15_000;
const ARTICLE_PAGE_TIMEOUT_MS = 10_000;
const DEFAULT_INGESTION_DEADLINE_MS = 45 * 60 * 1000;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface IngestionOptions {
  /** Absolute epoch-ms timestamp after which no new source/page/channel starts. */
  deadlineAt?: number;
}

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

interface ExistingArticleMeta {
  id: number;
  link: string;
  imageUrl: string | null;
  description: string | null;
  category: string[];
}

/** A feed item plus its deduplication key and guaranteed title, resolved once per source. */
interface PendingItem {
  item: FeedItem;
  link: string;
  title: string;
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
  let link = rawLink;
  if (rawLink.includes('%3C') || rawLink.includes('<')) {
    try {
      const decoded = decodeURIComponent(rawLink);
      const match = decoded.match(/href="([^"]+)"/);
      if (match) {
        const href = match[1];
        if (href.startsWith('/')) {
          link = new URL(rawLink).origin + href;
        } else {
          link = href;
        }
      }
    } catch {
      // fall through to raw link
    }
  }
  return normalizeArticleUrl(link);
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

function absolutizeUrl(value: string, base: string): string | null {
  if (!value) return null;
  if (value.startsWith('http')) return value;
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

function resolveFeedImage(link: string, feedHtml: string): string | null {
  if (!feedHtml) return null;
  const src = firstImageFromHtml(feedHtml);
  return src ? absolutizeUrl(src, link) : null;
}

/**
 * Fetches an article page once for ingest. Returns both the selector paragraphs
 * and the og:image so a new article costs a single request instead of two.
 */
async function fetchArticlePage(
  url: string,
  selector: string,
): Promise<{ paragraphs: string[]; imageUrl: string | null }> {
  try {
    const { data } = await fetchWithRetry(url, {
      timeout: ARTICLE_PAGE_TIMEOUT_MS,
      headers: { 'User-Agent': USER_AGENT },
    });
    const $ = cheerio.load(data);
    const paragraphs: string[] = [];
    $(selector).each((_, el) => {
      const text = $(el).text().trim();
      if (text) paragraphs.push(text);
    });

    const ogImage = $('meta[property="og:image"]').attr('content');
    return { paragraphs, imageUrl: ogImage ? absolutizeUrl(ogImage, url) : null };
  } catch (err) {
    logger.warn({ url, err }, 'Failed to parse article page');
    return { paragraphs: [], imageUrl: null };
  }
}

/** Page fetch used only for image backfill of already-stored articles. */
async function fetchArticlePageImage(link: string): Promise<string | null> {
  try {
    const { data } = await fetchWithRetry(link, {
      timeout: 8000,
      headers: { 'User-Agent': USER_AGENT },
    });
    const $ = cheerio.load(data);
    const ogImage = $('meta[property="og:image"]').attr('content');
    return ogImage ? absolutizeUrl(ogImage, link) : null;
  } catch {
    logger.warn({ link }, 'Failed to fetch article page for image');
  }

  return null;
}

export async function runSierraLeoneIngestion(options: IngestionOptions = {}) {
  logger.info('Starting Sierra Leone Ingestion Cycle');

  // Per-run wall-clock budget for the whole cycle. Read at run start so an env
  // change applies without a restart, and injectable for tests via options.
  const configuredDeadlineMs = readPositiveIntEnv('INGESTION_DEADLINE_MS', DEFAULT_INGESTION_DEADLINE_MS);
  const deadlineAt = options.deadlineAt ?? Date.now() + configuredDeadlineMs;
  const deadlineReached = () => Date.now() >= deadlineAt;

  // Budget for article-page image fetches during metadata backfill. Feed HTML
  // image extraction is free and stays uncapped; only the extra page fetch is
  // limited, and the counters are shared across all sources in this run.
  const runStartedAt = Date.now();
  let imageFetches = 0;
  const canFetchImage = () =>
    imageFetches < MAX_IMAGE_FETCHES_PER_RUN && Date.now() - runStartedAt < BACKFILL_BUDGET_MS;

  for (const source of SIERRA_LEONE_SOURCES) {
    if (deadlineReached()) {
      logger.warn({ source: source.name, deadlineAt }, 'Ingestion deadline reached; skipping remaining article feeds');
      break;
    }

    logger.info({ source: source.name }, 'Checking feed');

    try {
      const feedResponse = await fetchWithRetry(source.feedUrl, {
        timeout: FEED_TIMEOUT_MS,
        headers: { 'User-Agent': USER_AGENT },
      });
      const feed = await parser.parseString(String(feedResponse.data));

      // Normalize the whole feed first so dedupe is one batched query per source
      // instead of one findUnique per item.
      const pendingItems: PendingItem[] = [];
      for (const feedItem of feed.items as FeedItem[]) {
        if (!feedItem.link || !feedItem.title) continue;
        pendingItems.push({ item: feedItem, link: extractRealLink(feedItem.link), title: feedItem.title });
      }

      const existingByLink = new Map<string, ExistingArticleMeta>();
      if (pendingItems.length > 0) {
        const existingArticles = await prisma.article.findMany({
          where: { link: { in: pendingItems.map((pending) => pending.link) } },
          select: { id: true, link: true, imageUrl: true, description: true, category: true },
        });
        for (const article of existingArticles) existingByLink.set(article.link, article);
      }

      for (const { item, link, title } of pendingItems) {
        try {
          const existing = existingByLink.get(link);

          if (existing) {
            // Fill only metadata that is still missing, using the feed item we
            // already fetched. Existing values are never overwritten.
            const updateData: Record<string, unknown> = {};

            if (!existing.imageUrl) {
              const feedHtml = getFeedContentHtml(item);
              const feedImage = resolveFeedImage(link, feedHtml);
              if (feedImage) {
                updateData.imageUrl = feedImage;
              } else if (canFetchImage()) {
                imageFetches++;
                const pageImage = await fetchArticlePageImage(link);
                if (pageImage) updateData.imageUrl = pageImage;
              }
            }

            if (!existing.description) {
              const description = extractDescription(item);
              if (description) updateData.description = description;
            }

            if (existing.category.length === 0 && item.categories && item.categories.length > 0) {
              updateData.category = item.categories;
            }

            if (Object.keys(updateData).length > 0) {
              await prisma.article.update({ where: { id: existing.id }, data: updateData });
              logger.trace({ id: existing.id, title: title.slice(0, 50) }, 'Backfilled article meta');
            }

            continue;
          }

          logger.info({ title }, 'Ingesting article');

          // One request for both paragraphs and og:image.
          const page = await fetchArticlePage(link, source.contentSelector);
          const feedHtml = getFeedContentHtml(item);
          const paragraphs = page.paragraphs.length > 0 ? page.paragraphs : paragraphsFromHtml(feedHtml);
          // Prefer the feed image (free); fall back to the page og:image.
          const imageUrl = resolveFeedImage(link, feedHtml) ?? page.imageUrl;
          const description = extractDescription(item);

          // Upsert instead of create: if an overlapping scrape run ingested this
          // link in the meantime, this becomes a no-op instead of a unique-constraint crash.
          await prisma.article.upsert({
            where: { link },
            update: {},
            create: {
              title: title,
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

          await sleep(1000);
        } catch (itemError) {
          logger.warn({ title, error: itemError }, 'Error ingesting article');
        }
      }
    } catch (feedError) {
      logger.error({ source: source.name, error: feedError }, 'Error reading feed');
    }
  }

  logger.info('Article Ingestion Cycle Complete');

  // Sitemap fallback: catch articles the RSS feed may have missed
  await scrapeTelegraphFromSitemap(deadlineAt);

  // Video feeds: ingest latest video broadcasts & shorts
  await runSierraLeoneVideoIngestion(deadlineAt);

  logger.info('Full Ingestion Cycle Complete');
}

export { runSierraLeoneVideoIngestion };

/**
 * Scrape the WordPress sitemap for article URLs that may have been missed by the RSS feed.
 * The Telegraph RSS only returns ~10 items; the sitemap has the full archive, split across
 * numbered pages (newest-first). We walk every page and ingest anything not yet in the DB,
 * up to a per-run cap, so older articles are gradually backfilled instead of being starved
 * by always re-scanning the same newest-50 window.
 */
const TELEGRAPH_SITEMAP_BASE = 'https://www.thesierraleonetelegraph.com/wp-sitemap-posts-post-';
const SITEMAP_MAX_PAGES = 20; // Hard safety cap on pagination
const SITEMAP_MAX_INGEST_PER_RUN = 50; // Politeness cap per run
const SITEMAP_KNOWN_PAGES_BEFORE_STOP = 2; // Converged once this many pages are fully known
const SITEMAP_END_STATUSES = new Set([404, 410]);

export function parseSitemapUrls(xml: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls: string[] = [];
  $('url loc').each((_, el) => {
    const url = $(el).text().trim();
    if (url) urls.push(url);
  });
  return urls;
}

function httpStatusOf(err: unknown): number | undefined {
  return (err as { response?: { status?: number } }).response?.status;
}

async function scrapeTelegraphFromSitemap(deadlineAt: number): Promise<void> {
  const deadlineReached = () => Date.now() >= deadlineAt;
  let ingested = 0;

  try {
    if (deadlineReached()) {
      logger.warn({ deadlineAt }, 'Ingestion deadline reached; skipping sitemap walk');
      return;
    }

    // Load every link we already have for this source in one query so dedup is O(1)
    // instead of a findUnique per sitemap URL.
    const existingLinks = new Set(
      (
        await prisma.article.findMany({
          where: { source: 'The Sierra Leone Telegraph' },
          select: { link: true },
        })
      ).map((a) => a.link),
    );

    let consecutiveKnownPages = 0;

    for (let page = 1; page <= SITEMAP_MAX_PAGES; page++) {
      if (deadlineReached()) {
        logger.warn({ page, deadlineAt }, 'Ingestion deadline reached; skipping remaining sitemap pages');
        break;
      }

      const sitemapUrl = `${TELEGRAPH_SITEMAP_BASE}${page}.xml`;

      let urls: string[];
      try {
        const resp = await fetchWithRetry(
          sitemapUrl,
          { timeout: 15000, headers: { 'User-Agent': USER_AGENT } },
          { deadlineMs: deadlineAt },
        );
        urls = parseSitemapUrls(resp.data);
      } catch (err) {
        const status = httpStatusOf(err);
        if (status !== undefined && SITEMAP_END_STATUSES.has(status)) {
          // A 404/410 on a numbered page is the normal end of the sitemap.
          logger.info({ page, status }, 'Sitemap end reached (404/410)');
        } else {
          // Any other failure (5xx, network) is not evidence of the end; stop
          // this run and retry the walk next cycle.
          logger.error({ page, err }, 'Sitemap page fetch failed; stopping sitemap walk');
        }
        break;
      }

      if (urls.length === 0) {
        logger.info({ page }, 'Sitemap page has no URLs; reached end of sitemap');
        break;
      }

      const pageUrls = urls.map(normalizeArticleUrl);
      const unknownUrls = pageUrls.filter((url) => !existingLinks.has(url));

      if (unknownUrls.length === 0) {
        consecutiveKnownPages++;
        logger.info({ page, consecutiveKnownPages }, 'Sitemap page fully known');
        if (consecutiveKnownPages >= SITEMAP_KNOWN_PAGES_BEFORE_STOP) {
          logger.info({ page }, 'Sitemap converged (consecutive fully-known pages); stopping walk');
          break;
        }
        continue;
      }
      consecutiveKnownPages = 0;

      logger.info({ page, totalUrls: urls.length, newUrls: unknownUrls.length }, 'Sitemap page found URLs');

      for (const url of unknownUrls) {
        if (existingLinks.has(url)) continue;

        if (ingested >= SITEMAP_MAX_INGEST_PER_RUN) {
          logger.info({ ingested }, 'Sitemap ingest cap reached; remaining articles will be picked up on later runs');
          return;
        }

        if (deadlineReached()) {
          logger.warn({ ingested, deadlineAt }, 'Ingestion deadline reached; skipping remaining sitemap items');
          return;
        }

        try {
          const pageResp = await fetchWithRetry(
            url,
            { timeout: 10000, headers: { 'User-Agent': USER_AGENT } },
            { deadlineMs: deadlineAt },
          );
          const page$ = cheerio.load(pageResp.data);
          const title =
            page$('meta[property="og:title"]').attr('content') || page$('title').text().trim() || 'Untitled';
          const description =
            page$('meta[property="og:description"]').attr('content') ||
            page$('meta[name="description"]').attr('content') ||
            '';
          const imageUrl = page$('meta[property="og:image"]').attr('content') || null;
          const author =
            page$('meta[property="article:author"]').attr('content') ||
            page$('.entry-author a').text().trim() ||
            'The Sierra Leone Telegraph';
          const pubDateStr =
            page$('meta[property="article:published_time"]').attr('content') ||
            page$('time.entry-date').attr('datetime') ||
            '';
          const paragraphs: string[] = [];
          page$('.entry-content p, .entry-content h2').each((_, el) => {
            const text = page$(el).text().trim();
            if (text && text.length > 40) paragraphs.push(text);
          });

          await prisma.article.upsert({
            where: { link: url },
            update: {},
            create: {
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
          existingLinks.add(url); // keep in-memory dedup in sync
          ingested++;
          await sleep(1500); // Rate limit
        } catch (itemErr) {
          logger.warn({ url, error: itemErr }, 'Sitemap item scrape failed');
        }
      }
    }

    logger.info({ ingested }, 'Sitemap scrape complete');
  } catch (err) {
    logger.error({ err }, 'Sitemap scrape failed');
  }
}
