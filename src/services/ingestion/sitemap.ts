import * as cheerio from 'cheerio';
import { prisma } from '../../db.js';
import { parsePublishedDate } from '../../utils/dates.js';
import { USER_AGENT, fetchWithRetry, sleep } from '../../utils/http.js';
import { normalizeArticleUrl } from '../../utils/url.js';
import logger from '../../logger.js';

const TELEGRAPH_SITEMAP_BASE = 'https://www.thesierraleonetelegraph.com/wp-sitemap-posts-post-';
const SITEMAP_MAX_PAGES = 20;
const SITEMAP_MAX_INGEST_PER_RUN = 50;
const SITEMAP_KNOWN_PAGES_BEFORE_STOP = 2;
const SITEMAP_END_STATUSES = new Set([404, 410]);
const SITEMAP_SOURCE = 'The Sierra Leone Telegraph';

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

async function loadExistingLinks(deadlineAt: number): Promise<Set<string>> {
  const rows = await prisma.article.findMany({
    where: { source: SITEMAP_SOURCE },
    select: { link: true },
  });
  if (Date.now() >= deadlineAt) {
    logger.warn({ deadlineAt }, 'Ingestion deadline reached; skipping sitemap walk');
  }
  return new Set(rows.map((row) => row.link));
}

/** Reads one sitemap page; returns null when the walk should stop. */
async function readSitemapPage(page: number, deadlineAt: number): Promise<string[] | null> {
  const sitemapUrl = `${TELEGRAPH_SITEMAP_BASE}${page}.xml`;
  try {
    const response = await fetchWithRetry(
      sitemapUrl,
      { timeout: 15000, headers: { 'User-Agent': USER_AGENT } },
      { deadlineMs: deadlineAt },
    );
    return parseSitemapUrls(readBody(response.data));
  } catch (err) {
    const status = httpStatusOf(err);
    if (status !== undefined && SITEMAP_END_STATUSES.has(status)) {
      logger.info({ page, status }, 'Sitemap end reached (404/410)');
    } else {
      logger.error({ page, err }, 'Sitemap page fetch failed; stopping sitemap walk');
    }
    return null;
  }
}

function readBody(data: unknown): string {
  return typeof data === 'string' ? data : String(data);
}

async function ingestSitemapUrl(url: string, deadlineAt: number): Promise<boolean> {
  try {
    const pageResponse = await fetchWithRetry(
      url,
      { timeout: 10000, headers: { 'User-Agent': USER_AGENT } },
      { deadlineMs: deadlineAt },
    );
    const page$ = cheerio.load(readBody(pageResponse.data));
    const title = page$('meta[property="og:title"]').attr('content') || page$('title').text().trim() || 'Untitled';
    const description =
      page$('meta[property="og:description"]').attr('content') ||
      page$('meta[name="description"]').attr('content') ||
      '';
    const imageUrl = page$('meta[property="og:image"]').attr('content') || null;
    const author =
      page$('meta[property="article:author"]').attr('content') ||
      page$('.entry-author a').text().trim() ||
      SITEMAP_SOURCE;
    const pubDateRaw =
      page$('meta[property="article:published_time"]').attr('content') ||
      page$('time.entry-date').attr('datetime') ||
      '';
    const published = parsePublishedDate(pubDateRaw);
    const paragraphs: string[] = [];
    page$('.entry-content p, .entry-content h2').each((_, el) => {
      const text = page$(el).text().trim();
      if (text && text.length > 40) paragraphs.push(text);
    });
    // No body found means an empty row, never a fabricated summary paragraph.
    const contentSource = paragraphs.length > 0 ? 'page' : 'empty';
    const contentAttempts = contentSource === 'empty' ? 1 : 0;

    await prisma.article.upsert({
      where: { link: url },
      update: {},
      create: {
        title: title.slice(0, 500),
        link: url,
        pubDate: published.date,
        pubDateSource: published.source,
        pubDateRaw: published.raw,
        author: author.slice(0, 200),
        description: description.slice(0, 500),
        category: [],
        imageUrl,
        paragraphs,
        contentSource,
        contentAttempts,
        lastContentAttemptAt: contentAttempts > 0 ? new Date() : null,
        source: SITEMAP_SOURCE,
      },
    });
    await sleep(1500);
    return true;
  } catch (itemErr) {
    logger.warn({ url, error: itemErr }, 'Sitemap item scrape failed');
    return false;
  }
}

/**
 * Scrape the WordPress sitemap for article URLs that may have been missed by the
 * RSS feed. The Telegraph RSS only returns ~10 items; the sitemap has the full
 * archive, split across numbered pages (newest-first). We walk every page and
 * ingest anything not yet in the DB, up to a per-run cap, so older articles are
 * gradually backfilled instead of being starved by always re-scanning the same
 * newest-50 window.
 */
export async function scrapeTelegraphFromSitemap(deadlineAt: number): Promise<void> {
  let ingested = 0;
  try {
    if (Date.now() >= deadlineAt) {
      logger.warn({ deadlineAt }, 'Ingestion deadline reached; skipping sitemap walk');
      return;
    }

    const existingLinks = await loadExistingLinks(deadlineAt);
    let consecutiveKnownPages = 0;

    for (let page = 1; page <= SITEMAP_MAX_PAGES; page++) {
      if (Date.now() >= deadlineAt) {
        logger.warn({ page, deadlineAt }, 'Ingestion deadline reached; skipping remaining sitemap pages');
        break;
      }

      const urls = await readSitemapPage(page, deadlineAt);
      if (urls === null) break;
      if (urls.length === 0) {
        logger.info({ page }, 'Sitemap page has no URLs; reached end of sitemap');
        break;
      }

      const unknownUrls = urls.map(normalizeArticleUrl).filter((url) => !existingLinks.has(url));
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
        if (Date.now() >= deadlineAt) {
          logger.warn({ ingested, deadlineAt }, 'Ingestion deadline reached; skipping remaining sitemap items');
          return;
        }
        if (await ingestSitemapUrl(url, deadlineAt)) {
          existingLinks.add(url);
          ingested++;
        }
      }
    }

    logger.info({ ingested }, 'Sitemap scrape complete');
  } catch (err) {
    logger.error({ err }, 'Sitemap scrape failed');
  }
}
