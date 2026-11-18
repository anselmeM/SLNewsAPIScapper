import { Router, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { SIERRA_LEONE_SOURCES } from '../config/sources.js';
import { parsePagination, parseCursor, encodeCursor } from '../utils/pagination.js';
import { buildArticleWhere, parseListFilters, toArticleMeta } from '../utils/listFilters.js';
import logger from '../logger.js';

const router = Router();

const VALID_SOURCES = SIERRA_LEONE_SOURCES.map((s) => s.name);

// The sellable contract is metadata + summary only (link + summary model):
// headline, summary, source, category, pub date, and the link back to the
// publisher. Full article text (paragraphs) is never exposed to API customers.
const ARTICLE_META_SELECT = {
  id: true,
  title: true,
  description: true,
  source: true,
  category: true,
  link: true,
  pubDate: true,
} as const;

/**
 * @swagger
 * /v1/news:
 *   get:
 *     summary: List news articles (versioned business contract)
 *     description: |
 *       Link + summary model: returns article metadata only — headline,
 *       summary, source, category, published date and the link back to the
 *       publisher. Full text is never exposed to API customers. Undated items
 *       (no parseable published date) are excluded from this sellable feed;
 *       they remain visible on the internal `/api/news` surface.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page_size
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of articles per page (also accepts `limit` as an alias)
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination (1-based). Cannot be combined with `cursor`.
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: |
 *           Opaque keyset cursor from a previous response's `meta.next_cursor`.
 *           Cannot be combined with `page`. In cursor mode `meta.page` and
 *           `meta.total` are null, the count query is skipped, and
 *           `meta.next_cursor` is null on the last page.
 *       - in: query
 *         name: source
 *         schema:
 *           type: string
 *         description: Filter by source name
 *       - in: query
 *         name: category
 *         schema:
 *           type: array
 *           items:
 *             type: string
 *         style: form
 *         explode: true
 *         description: Filter by category (repeat the param or comma-separate, e.g. ?category=politics&category=economy)
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date
 *         description: Earliest published date (ISO) to include
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date
 *         description: Latest published date (ISO) to include
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Search keyword across headline and summary (case-insensitive)
 *     responses:
 *       200:
 *         description: Paginated article metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data, meta]
 *               properties:
 *                 data:
 *                   type: array
 *                   description: Article metadata only — full text is never exposed
 *                   items:
 *                     type: object
 *                     required: [id, title, summary, source, category, url, published_at]
 *                     properties:
 *                       id:
 *                         type: integer
 *                       title:
 *                         type: string
 *                       summary:
 *                         type: string
 *                         nullable: true
 *                         description: Publisher summary; null when the feed provided none
 *                       source:
 *                         type: string
 *                       category:
 *                         type: array
 *                         items:
 *                           type: string
 *                       url:
 *                         type: string
 *                       published_at:
 *                         type: string
 *                         format: date-time
 *                       teams:
 *                         type: array
 *                         items:
 *                           type: string
 *                         description: |
 *                           Follow ids the story is about (`league:spl`,
 *                           `team:leone-stars`), derived from the headline and
 *                           summary. Empty when no followable subject matched.
 *                 meta:
 *                   type: object
 *                   required: [page, page_size, total, has_more, next_cursor]
 *                   properties:
 *                     page:
 *                       type: integer
 *                       nullable: true
 *                       description: Page number in offset mode; null in cursor mode
 *                     page_size:
 *                       type: integer
 *                     total:
 *                       type: integer
 *                       nullable: true
 *                       description: Exact total in offset mode; null in cursor mode (no count query)
 *                     has_more:
 *                       type: boolean
 *                     next_cursor:
 *                       type: string
 *                       nullable: true
 *                       description: Opaque keyset cursor for the next page, or null when exhausted
 *       400:
 *         description: Invalid parameters
 *       401:
 *         description: Invalid or missing API key
 *       403:
 *         description: Key without access to this endpoint
 *       429:
 *         description: Rate limit exceeded (Retry-After header included)
 *       500:
 *         description: Server error
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { category, source, page, page_size, limit, from, to, q, cursor } = req.query;

    const filters = parseListFilters({ q, category, from, to });
    if (filters.error) {
      return res.status(400).json({ error: filters.error });
    }

    if (cursor !== undefined && page !== undefined) {
      return res.status(400).json({ error: 'use either page or cursor, not both' });
    }

    // page_size is the contract param; limit is accepted as a legacy alias.
    const pagination = parsePagination({
      pageRaw: page,
      pageSizeRaw: page_size,
      limitRaw: limit,
      clampPageSize: false,
    });
    if ('error' in pagination) {
      return res.status(400).json({ error: pagination.error });
    }
    const { page: parsedPage, pageSize: parsedPageSize } = pagination;

    const { cursor: parsedCursor, error: cursorError } = parseCursor(cursor);
    if (cursorError) {
      return res.status(400).json({ error: cursorError });
    }

    // Sellable feeds never surface rows whose published date could not be
    // parsed; the pinned internal app still sees them via /api/news.
    const where: Prisma.ArticleWhereInput = {};
    const built = buildArticleWhere(where, filters, {
      source,
      validSources: VALID_SOURCES,
      excludeMissingDate: true,
      cursor: parsedCursor,
    });
    if (built.error) {
      return res.status(400).json({ error: built.error });
    }

    // Cursor mode: no count query. Fetching one extra row tells us has_more and
    // yields the next cursor from the last *returned* row.
    if (parsedCursor) {
      const rows = await prisma.article.findMany({
        select: ARTICLE_META_SELECT,
        orderBy: [{ pubDate: 'desc' }, { id: 'desc' }],
        take: parsedPageSize + 1,
        where,
      });
      const hasMore = rows.length > parsedPageSize;
      const dataRows = hasMore ? rows.slice(0, parsedPageSize) : rows;
      const lastRow = dataRows[dataRows.length - 1];
      const nextCursor = hasMore && lastRow ? encodeCursor(lastRow.pubDate, lastRow.id) : null;

      res.set('Cache-Control', 'private, max-age=300');
      return res.json({
        data: dataRows.map(toArticleMeta),
        meta: {
          page: null,
          page_size: parsedPageSize,
          total: null,
          has_more: hasMore,
          next_cursor: nextCursor,
        },
      });
    }

    const [articles, total] = await Promise.all([
      prisma.article.findMany({
        // Deterministic order (pubDate desc, id desc tiebreaker) so pages don't
        // shuffle articles that share a pubDate between requests.
        select: ARTICLE_META_SELECT,
        orderBy: [{ pubDate: 'desc' }, { id: 'desc' }],
        take: parsedPageSize,
        skip: pagination.skip,
        where,
      }),
      prisma.article.count({ where }),
    ]);

    const hasMore = parsedPage * parsedPageSize < total;
    const lastArticle = articles[articles.length - 1];
    // Page mode can still bootstrap cursor pagination: return the keyset
    // position of the last row so a client can switch to `cursor=` and stop
    // paying for deep OFFSETs and exact counts.
    const nextCursor = hasMore && lastArticle ? encodeCursor(lastArticle.pubDate, lastArticle.id) : null;

    res.set('Cache-Control', 'private, max-age=300');
    res.json({
      data: articles.map(toArticleMeta),
      meta: {
        page: parsedPage,
        page_size: parsedPageSize,
        total,
        has_more: hasMore,
        next_cursor: nextCursor,
      },
    });
  } catch (error) {
    logger.error(error, 'Failed to fetch articles');
    res.status(500).json({ error: 'Failed to retrieve articles' });
  }
});

export default router;
