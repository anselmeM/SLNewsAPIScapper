import Parser from 'rss-parser';
import { prisma } from '../../db.js';
import { SIERRA_LEONE_SOURCES } from '../../config/sources.js';
import type { DedupeIndex } from '../dedupe.js';
import { recordSourceFailure, recordSourceSuccess, shouldSkipSource } from '../source-health.js';
import { USER_AGENT, fetchWithRetry, sleep } from '../../utils/http.js';
import { parsePublishedDate } from '../../utils/dates.js';
import logger from '../../logger.js';
import {
  canRepairContent,
  contentRepairUpdate,
  contentSelectorForSource,
  extractDescription,
  extractRealLink,
  fetchArticlePage,
  fetchArticlePageImage,
  finalizeImageUrl,
  getFeedContentHtml,
  needsContentRepair,
  paragraphsFromHtml,
  resolveFeedImage,
} from './content.js';
import type { ContentRepairContext, ExistingArticleMeta, FeedItem, IngestionRunContext, PendingItem } from './types.js';

const parser = new Parser();
const MAX_IMAGE_FETCHES_PER_RUN = 10;
const BACKFILL_BUDGET_MS = 60_000;
const FEED_TIMEOUT_MS = 15_000;

function canFetchImage(context: IngestionRunContext): boolean {
  return context.imageFetches < MAX_IMAGE_FETCHES_PER_RUN && Date.now() - context.startedAt < BACKFILL_BUDGET_MS;
}

function pendingFeedItems(items: FeedItem[]): PendingItem[] {
  const pending: PendingItem[] = [];
  for (const feedItem of items) {
    if (!feedItem.link || !feedItem.title) continue;
    pending.push({
      item: feedItem,
      link: extractRealLink(feedItem.link),
      title: feedItem.title,
    });
  }
  return pending;
}

/**
 * Cross-source dedupe: compare against the DB and PRIOR sources only. Comparing
 * inside one feed would suppress legitimate near-identical headlines from the
 * same publisher, so the index is snapshotted first and accepted items are
 * added after the pass.
 */
function dedupePending(sourceName: string, pending: PendingItem[], index: DedupeIndex): PendingItem[] {
  const sourceIndex = index.snapshot();
  const accepted: PendingItem[] = [];
  for (const item of pending) {
    if (sourceIndex.isDuplicate(item.link, item.title)) {
      logger.info({ source: sourceName, title: item.title }, 'Skipping duplicate story already ingested');
      continue;
    }
    accepted.push(item);
  }
  for (const item of accepted) index.add(item.link, item.title);
  return accepted;
}

async function loadExisting(links: string[]): Promise<Map<string, ExistingArticleMeta>> {
  const existingByLink = new Map<string, ExistingArticleMeta>();
  if (links.length === 0) return existingByLink;
  const existingArticles = await prisma.article.findMany({
    where: { link: { in: links } },
    select: {
      id: true,
      link: true,
      imageUrl: true,
      description: true,
      category: true,
      source: true,
      paragraphs: true,
      contentSource: true,
      contentAttempts: true,
    },
  });
  for (const article of existingArticles) existingByLink.set(article.link, article);
  return existingByLink;
}

async function updateExistingArticle(
  existing: ExistingArticleMeta,
  item: FeedItem,
  link: string,
  title: string,
  context: IngestionRunContext,
  contentRepairs: ContentRepairContext,
): Promise<void> {
  // Fill only metadata that is still missing, using the feed item we already
  // fetched. Existing values are never overwritten.
  const updateData: Record<string, unknown> = {};

  if (!existing.imageUrl) {
    const feedHtml = getFeedContentHtml(item);
    const feedImage = resolveFeedImage(link, feedHtml);
    if (feedImage) {
      const final = await finalizeImageUrl(feedImage);
      if (final) updateData.imageUrl = final;
    } else if (canFetchImage(context)) {
      context.imageFetches++;
      const final = await finalizeImageUrl(await fetchArticlePageImage(link));
      if (final) updateData.imageUrl = final;
    }
  }

  if (!existing.description) {
    const description = extractDescription(item);
    if (description) updateData.description = description;
  }

  if (existing.category.length === 0 && item.categories && item.categories.length > 0) {
    updateData.category = item.categories;
  }

  // Repair bodies that were stored empty (or legacy 'summary') while we already
  // have the feed item's article in hand.
  if (needsContentRepair(existing) && canRepairContent(contentRepairs)) {
    contentRepairs.repairs++;
    const page = await fetchArticlePage(link, contentSelectorForSource(existing.source));
    Object.assign(updateData, contentRepairUpdate(page, existing, updateData.imageUrl !== undefined));
  }

  if (Object.keys(updateData).length > 0) {
    await prisma.article.update({ where: { id: existing.id }, data: updateData });
    logger.trace({ id: existing.id, title: title.slice(0, 50) }, 'Backfilled article meta');
  }
}

async function createArticle(
  item: FeedItem,
  link: string,
  title: string,
  sourceName: string,
  sourceSelector: string,
): Promise<void> {
  logger.info({ title }, 'Ingesting article');

  // One request for both paragraphs and og:image.
  const page = await fetchArticlePage(link, sourceSelector);
  const feedHtml = getFeedContentHtml(item);
  const feedParagraphs = paragraphsFromHtml(feedHtml);
  const paragraphs = page.paragraphs.length > 0 ? page.paragraphs : feedParagraphs;
  const contentSource = page.paragraphs.length > 0 ? 'page' : feedParagraphs.length > 0 ? 'feed' : 'empty';
  const contentAttempts = contentSource === 'empty' ? 1 : 0;
  // Prefer the feed image (free); fall back to the page og:image.
  const imageUrl = await finalizeImageUrl(resolveFeedImage(link, feedHtml) ?? page.imageUrl);
  const description = extractDescription(item);
  const published = parsePublishedDate(item.pubDate);

  // Upsert instead of create: if an overlapping scrape run ingested this link
  // in the meantime, this becomes a no-op instead of a unique-constraint crash.
  await prisma.article.upsert({
    where: { link },
    update: {},
    create: {
      title,
      link,
      pubDate: published.date,
      pubDateSource: published.source,
      pubDateRaw: published.raw,
      author: item.creator || sourceName,
      description,
      category: item.categories || [],
      imageUrl,
      paragraphs,
      contentSource,
      contentAttempts,
      lastContentAttemptAt: contentAttempts > 0 ? new Date() : null,
      source: sourceName,
    },
  });

  await sleep(1000);
}

async function ingestSource(
  source: (typeof SIERRA_LEONE_SOURCES)[number],
  context: IngestionRunContext,
  dedupeIndex: DedupeIndex,
): Promise<void> {
  logger.info({ source: source.name }, 'Checking feed');
  const feedResponse = await fetchWithRetry(source.feedUrl, {
    timeout: FEED_TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT },
  });
  const feed = await parser.parseString(String(feedResponse.data));
  recordSourceSuccess(source.name);

  const pendingItems = dedupePending(source.name, pendingFeedItems(feed.items as FeedItem[]), dedupeIndex);
  const existingByLink = await loadExisting(pendingItems.map((pending) => pending.link));

  for (const { item, link, title } of pendingItems) {
    try {
      const existing = existingByLink.get(link);
      if (existing) {
        await updateExistingArticle(existing, item, link, title, context, context.contentRepairs);
        continue;
      }
      await createArticle(item, link, title, source.name, source.contentSelector);
    } catch (itemError) {
      logger.warn({ title, error: itemError }, 'Error ingesting article');
    }
  }
}

/** One pass over every configured RSS source, sharing the run's budgets. */
export async function ingestFeeds(context: IngestionRunContext, dedupeIndex: DedupeIndex): Promise<void> {
  for (const source of SIERRA_LEONE_SOURCES) {
    if (Date.now() >= context.deadlineAt) {
      logger.warn(
        { source: source.name, deadlineAt: context.deadlineAt },
        'Ingestion deadline reached; skipping remaining article feeds',
      );
      break;
    }

    if (shouldSkipSource(source.name)) {
      logger.warn({ source: source.name }, 'Skipping feed during backoff');
      continue;
    }

    try {
      await ingestSource(source, context, dedupeIndex);
    } catch (feedError) {
      recordSourceFailure(source.name, feedError);
      logger.error({ source: source.name, error: feedError }, 'Error reading feed');
    }
  }
}
