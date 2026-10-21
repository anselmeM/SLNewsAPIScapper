/**
 * Pure helpers shared by the four list routes (`/api/news`, `/api/videos`,
 * `/v1/news`, `/v1/videos`).
 *
 * They own the filter → Prisma `where` translation and the `/v1` metadata
 * mappers so the routes keep only HTTP concerns. The resulting queries are
 * intentionally identical to the previous inline implementations (direct
 * filters, search OR at `where.OR` in page mode, keyset + search under
 * `where.AND` in cursor mode).
 */
import type { Prisma } from '@prisma/client';
import { parseCategories, parseDateRange, parseSearchQuery } from './query.js';
import type { Cursor } from './pagination.js';

/** Raw filter query params, as received from Express (`unknown` on purpose). */
export interface ListFilterInput {
  q?: unknown;
  category?: unknown;
  from?: unknown;
  to?: unknown;
}

export interface ParsedListFilters {
  searchTerm?: string;
  categories: string[];
  fromDate?: Date;
  toDate?: Date;
  error?: string;
}

/** Parses `q`, `category`, `from` and `to`, short-circuiting on the first error. */
export function parseListFilters({ q, category, from, to }: ListFilterInput): ParsedListFilters {
  const { term: searchTerm, error: searchError } = parseSearchQuery(q);
  if (searchError) return { categories: [], error: searchError };

  const { fromDate, toDate, error: dateError } = parseDateRange(from, to);
  if (dateError) return { categories: [], error: dateError };

  return { searchTerm, categories: parseCategories(category), fromDate, toDate };
}

export interface ArticleWhereOptions {
  source?: unknown;
  validSources?: readonly string[];
  excludeMissingDate?: boolean;
  cursor?: Cursor;
}

export interface ArticleWhereResult {
  error?: string;
  /** Search predicates that were applied (also placed on `where.OR`/`where.AND`). */
  searchOr?: Prisma.ArticleWhereInput[];
}

/**
 * Applies the article filters to `where` (mutating it, like the previous inline
 * route code) and combines the search predicate with the cursor keyset when a
 * cursor is supplied.
 */
export function buildArticleWhere(
  where: Prisma.ArticleWhereInput,
  filters: ParsedListFilters,
  { source, validSources, excludeMissingDate, cursor }: ArticleWhereOptions = {},
): ArticleWhereResult {
  // Sellable feeds hide rows whose published date could not be parsed; the
  // legacy/internal surface includes them.
  if (excludeMissingDate) where.pubDateSource = { not: 'missing' };

  if (source) {
    const sourceStr = String(source);
    if (validSources && !validSources.includes(sourceStr)) {
      return { error: `Invalid source. Must be one of: ${validSources.join(', ')}` };
    }
    where.source = sourceStr;
  }

  if (filters.categories.length > 0) {
    where.category = { hasSome: filters.categories };
  }

  const pubDateFilter: { gte?: Date; lte?: Date } = {};
  if (filters.fromDate) pubDateFilter.gte = filters.fromDate;
  if (filters.toDate) pubDateFilter.lte = filters.toDate;
  if (Object.keys(pubDateFilter).length > 0) {
    where.pubDate = pubDateFilter;
  }

  const searchTerm = filters.searchTerm;
  const searchOr: Prisma.ArticleWhereInput[] | undefined =
    searchTerm && searchTerm.length > 0
      ? [
          { title: { contains: searchTerm, mode: 'insensitive' } },
          { description: { contains: searchTerm, mode: 'insensitive' } },
        ]
      : undefined;

  if (cursor) {
    // Keyset predicate for the (pubDate desc, id desc) order, combined with the
    // search predicate as AND siblings so neither clobbers the other.
    const keyset: Prisma.ArticleWhereInput = {
      OR: [{ pubDate: { lt: cursor.date } }, { pubDate: cursor.date, id: { lt: cursor.id } }],
    };
    where.AND = searchOr ? [{ OR: searchOr }, keyset] : [keyset];
  } else {
    if (searchOr) where.OR = searchOr;
  }

  return { searchOr };
}

export interface VideoWhereOptions {
  channel?: unknown;
  excludeMissingDate?: boolean;
  cursor?: Cursor;
}

export interface VideoWhereResult {
  error?: string;
  /** Search predicates that were applied (also placed on `where.OR`/`where.AND`). */
  searchOr?: Prisma.VideoWhereInput[];
}

/** Video counterpart of `buildArticleWhere` (uses `publishedAt`). */
export function buildVideoWhere(
  where: Prisma.VideoWhereInput,
  filters: ParsedListFilters,
  { channel, excludeMissingDate, cursor }: VideoWhereOptions = {},
): VideoWhereResult {
  if (excludeMissingDate) where.publishedAtSource = { not: 'missing' };

  if (channel) {
    where.channelTitle = { contains: String(channel), mode: 'insensitive' };
  }

  if (filters.categories.length > 0) {
    where.category = { hasSome: filters.categories };
  }

  const publishedAtFilter: { gte?: Date; lte?: Date } = {};
  if (filters.fromDate) publishedAtFilter.gte = filters.fromDate;
  if (filters.toDate) publishedAtFilter.lte = filters.toDate;
  if (Object.keys(publishedAtFilter).length > 0) {
    where.publishedAt = publishedAtFilter;
  }

  const searchTerm = filters.searchTerm;
  const searchOr: Prisma.VideoWhereInput[] | undefined =
    searchTerm && searchTerm.length > 0
      ? [
          { title: { contains: searchTerm, mode: 'insensitive' } },
          { description: { contains: searchTerm, mode: 'insensitive' } },
          { channelTitle: { contains: searchTerm, mode: 'insensitive' } },
        ]
      : undefined;

  if (cursor) {
    const keyset: Prisma.VideoWhereInput = {
      OR: [{ publishedAt: { lt: cursor.date } }, { publishedAt: cursor.date, id: { lt: cursor.id } }],
    };
    where.AND = searchOr ? [{ OR: searchOr }, keyset] : [keyset];
  } else {
    if (searchOr) where.OR = searchOr;
  }

  return { searchOr };
}

/** `/v1/news` article metadata payload (never includes full text). */
export function toArticleMeta(article: {
  id: number;
  title: string;
  description: string | null;
  source: string;
  category: string[];
  link: string;
  pubDate: Date;
}) {
  return {
    id: article.id,
    title: article.title,
    summary: article.description,
    source: article.source,
    category: article.category,
    url: article.link,
    published_at: article.pubDate,
  };
}

/** `/v1/videos` video metadata payload. */
export function toVideoMeta(video: {
  id: number;
  videoId: string;
  title: string;
  description: string | null;
  channelTitle: string;
  category: string[];
  url: string;
  thumbnailUrl: string | null;
  publishedAt: Date;
}) {
  return {
    id: video.id,
    video_id: video.videoId,
    title: video.title,
    summary: video.description,
    source: video.channelTitle,
    category: video.category,
    url: video.url,
    thumbnail_url: video.thumbnailUrl,
    published_at: video.publishedAt,
  };
}
