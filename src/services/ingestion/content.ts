import * as cheerio from 'cheerio';
import { SIERRA_LEONE_SOURCES } from '../../config/sources.js';
import { looksLikeChromeImage, probeAndFingerprint } from '../image-pipeline.js';
import { USER_AGENT, fetchWithRetry } from '../../utils/http.js';
import { normalizeArticleUrl } from '../../utils/url.js';
import logger from '../../logger.js';
import type { ContentRepairContext, ExistingArticleMeta, FeedItem } from './types.js';

const ARTICLE_PAGE_TIMEOUT_MS = 10_000;
const MAX_CONTENT_ATTEMPTS = 3;
const MAX_CONTENT_REPAIRS_PER_RUN = 5;
const CONTENT_REPAIR_BUDGET_MS = 60_000;
const MAX_IMAGE_VALIDATIONS_PER_RUN = 40;

/** Fallback selector for sitemap rows whose source is no longer configured. */
const GENERIC_CONTENT_SELECTOR = 'article p, .entry-content p, .post-content p, .article-content p, main p';

let imageValidations = 0;

export function extractRealLink(rawLink: string): string {
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

export function paragraphsFromHtml(html: string): string[] {
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
  let found: string | null = null;
  $('img').each((_, element) => {
    if (found) return;
    const node = $(element);
    // WordPress/Joomla lazy-loaders often leave src as a spacer and put the
    // real URL in a data attribute, or only in srcset.
    for (const attribute of ['src', 'data-src', 'data-lazy-src', 'data-original']) {
      const value = node.attr(attribute)?.trim();
      if (value && !value.startsWith('data:')) {
        found = value;
        return;
      }
    }
    found = pickLargestSrcset(node.attr('srcset') ?? node.attr('data-srcset'));
  });
  return found;
}

function pickLargestSrcset(value: string | undefined): string | null {
  if (!value || !value.trim()) return null;
  let best: string | null = null;
  let bestScore = -1;
  for (const candidate of value.split(',')) {
    const parts = candidate.trim().split(/\s+/);
    if (!parts[0] || parts[0].startsWith('data:')) continue;
    let score = 1;
    if (parts.length > 1) {
      const number = Number.parseFloat(parts[1].replace(/[^0-9.]/g, ''));
      if (!Number.isNaN(number)) {
        score = parts[1].endsWith('x') ? number * 1000 : number;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = parts[0];
    }
  }
  return best;
}

export function getFeedContentHtml(item: FeedItem): string {
  const encoded = item['content:encoded'];
  if (typeof encoded === 'string') return encoded;
  if (item.content) return item.content;
  if (item.description) return item.description;
  return '';
}

export function extractDescription(item: FeedItem): string | null {
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

export function absolutizeUrl(value: string, base: string): string | null {
  if (!value) return null;
  if (value.startsWith('http')) return value;
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

export function resolveFeedImage(link: string, feedHtml: string): string | null {
  if (!feedHtml) return null;
  const src = firstImageFromHtml(feedHtml);
  return src ? absolutizeUrl(src, link) : null;
}

/**
 * Best public preview image for a page.
 *
 * Paywalled/JS pages frequently omit og:image but still expose the sharing
 * image in twitter:image, link rel=image_src or JSON-LD. Those are public
 * preview metadata, not paywalled content.
 */
export function firstPageImage(html: string): string | null {
  const $ = cheerio.load(html);
  const candidates: Array<string | undefined> = [
    $('meta[property="og:image"]').attr('content'),
    $('meta[name="og:image"]').attr('content'),
    $('meta[name="twitter:image"]').attr('content'),
    $('meta[property="twitter:image"]').attr('content'),
    $('meta[itemprop="image"]').attr('content'),
    $('link[rel="image_src"]').attr('href'),
  ];
  for (const candidate of candidates) {
    if (candidate && !looksLikeChrome(candidate)) return candidate;
  }
  $('script[type="application/ld+json"]').each((_, node) => {
    if (candidates.length > 6) return;
    try {
      const data = JSON.parse($(node).text());
      const image = Array.isArray(data?.image) ? data.image[0] : data?.image;
      const url = typeof image === 'string' ? image : image?.url;
      if (typeof url === 'string') candidates.push(url);
    } catch {
      // ignore malformed JSON-LD
    }
  });
  const jsonLd = candidates.slice(6).find((value) => value && !looksLikeChrome(value));
  return jsonLd ?? null;
}

function looksLikeChrome(url: string): boolean {
  return /(favicon|sprite|placeholder|avatar|blank\.gif|pixel\.gif)/i.test(url);
}

export function contentSelectorForSource(sourceName: string): string {
  const configured = SIERRA_LEONE_SOURCES.find((source) => source.name === sourceName);
  return configured?.contentSelector ?? GENERIC_CONTENT_SELECTOR;
}

function isRepairableContentSource(contentSource: string | null): boolean {
  return contentSource === 'empty' || contentSource === 'summary';
}

/** True when a stored article has no body and still has repair attempts left. */
export function needsContentRepair(article: ExistingArticleMeta): boolean {
  return (
    isRepairableContentSource(article.contentSource) &&
    article.contentAttempts < MAX_CONTENT_ATTEMPTS &&
    article.paragraphs.length === 0
  );
}

/** Bounded per-run content repair budget shared by feed backfill and the sweep. */
export function canRepairContent(context: ContentRepairContext): boolean {
  return (
    context.repairs < MAX_CONTENT_REPAIRS_PER_RUN &&
    Date.now() - context.startedAt < CONTENT_REPAIR_BUDGET_MS &&
    Date.now() < context.deadlineAt
  );
}

export function contentRepairUpdate(
  page: { paragraphs: string[]; imageUrl: string | null },
  article: { imageUrl: string | null },
  alreadyFilledImage: boolean,
): Record<string, unknown> {
  const now = new Date();

  if (page.paragraphs.length > 0) {
    const update: Record<string, unknown> = {
      paragraphs: page.paragraphs,
      contentSource: 'page',
      contentAttempts: 0,
      lastContentAttemptAt: now,
    };
    // Only rescue the image when it is still missing and this run has not
    // already found one (the feed image always wins).
    if (!article.imageUrl && !alreadyFilledImage && page.imageUrl) update.imageUrl = page.imageUrl;
    return update;
  }

  return {
    contentSource: 'empty',
    contentAttempts: { increment: 1 },
    lastContentAttemptAt: now,
  };
}

/**
 * Fetches an article page once for ingest. Returns both the selector paragraphs
 * and the og:image so a new article costs a single request instead of two.
 */
export async function fetchArticlePage(
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

    const ogImage = firstPageImage(String($.html()));
    return { paragraphs, imageUrl: ogImage ? absolutizeUrl(ogImage, url) : null };
  } catch (err) {
    logger.warn({ url, err }, 'Failed to parse article page');
    return { paragraphs: [], imageUrl: null };
  }
}

/**
 * Validates and fingerprints an image before it is stored.
 *
 * Cheap rejections (logos/spacers) are free; byte-level dimension checks are
 * budgeted per run. A transient fetch failure keeps the original URL — a flaky
 * CDN must not remove every picture from the feed — but an unsafe (SSRF-blocked)
 * image is dropped instead of being stored and served.
 */
export async function finalizeImageUrl(candidate: string | null): Promise<string | null> {
  if (!candidate) return null;
  if (looksLikeChromeImage(candidate)) return null;
  if (imageValidations >= MAX_IMAGE_VALIDATIONS_PER_RUN) return candidate;
  imageValidations += 1;
  const probe = await probeAndFingerprint(candidate);
  return probe.ok ? probe.url : null;
}

/** Page fetch used only for image backfill of already-stored articles. */
export async function fetchArticlePageImage(link: string): Promise<string | null> {
  try {
    const { data } = await fetchWithRetry(link, {
      timeout: 8000,
      headers: { 'User-Agent': USER_AGENT },
    });
    const $ = cheerio.load(data);
    const ogImage = firstPageImage(String($.html()));
    return ogImage ? absolutizeUrl(ogImage, link) : null;
  } catch {
    logger.warn({ link }, 'Failed to fetch article page for image');
  }

  return null;
}
