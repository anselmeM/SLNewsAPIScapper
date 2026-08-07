import { Router, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { SIERRA_LEONE_SOURCES } from '../config/sources.js';
import logger from '../logger.js';

const router = Router();

const VALID_SOURCES = SIERRA_LEONE_SOURCES.map((s) => s.name);
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE = 10_000; // cap the offset window; the archive is far smaller

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

interface V1QueryOptions {
  select: typeof ARTICLE_META_SELECT;
  orderBy: Array<{ pubDate: 'desc' } | { id: 'desc' }>;
  take: number;
  skip?: number;
  where?: Prisma.ArticleWhereInput;
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : NaN;
}

/**
 * @swagger
 * /v1/news:
 *   get:
 *     summary: List news articles (versioned business contract)
 *     description: |
 *       Link + summary model: returns article metadata only — headline,
 *       summary, source, category, published date and the link back to the
 *       publisher. Full text is never exposed to API customers.
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
 *         description: Page number for pagination (1-based)
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
 *                 meta:
 *                   type: object
 *                   required: [page, page_size, total, has_more]
 *                   properties:
 *                     page:
 *                       type: integer
 *                     page_size:
 *                       type: integer
 *                     total:
 *                       type: integer
 *                     has_more:
 *                       type: boolean
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
    const { category, source, page, page_size, limit, from, to } = req.query;

    // page_size is the contract param; limit is accepted as a legacy alias.
    const parsedPageSize = parsePositiveInt(page_size, parsePositiveInt(limit, DEFAULT_PAGE_SIZE));
    if (Number.isNaN(parsedPageSize) || parsedPageSize > MAX_PAGE_SIZE) {
      return res.status(400).json({ error: `page_size must be a positive integer up to ${MAX_PAGE_SIZE}` });
    }

    const parsedPage = parsePositiveInt(page, 1);
    if (Number.isNaN(parsedPage)) {
      return res.status(400).json({ error: 'page must be a positive integer' });
    }
    if (parsedPage > MAX_PAGE) {
      return res.status(400).json({ error: `page must not exceed ${MAX_PAGE}` });
    }

    // Date window validation
    const fromDate = from ? new Date(String(from)) : undefined;
    const toDate = to ? new Date(String(to)) : undefined;
    if (from && (Number.isNaN(fromDate!.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(String(from)))) {
      return res.status(400).json({ error: 'from must be a valid ISO date' });
    }
    if (to && (Number.isNaN(toDate!.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(String(to)))) {
      return res.status(400).json({ error: 'to must be a valid ISO date' });
    }
    if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
      return res.status(400).json({ error: 'from must not be after to' });
    }
    // A date-only `to` (e.g. 2026-08-07) means "end of that day", not midnight.
    if (to && toDate && /^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
      toDate.setUTCHours(23, 59, 59, 999);
    }

    // category: string[] via repeated params or comma-separated values
    const rawCategories = category === undefined ? [] : Array.isArray(category) ? category : [category];
    const categories = rawCategories
      .flatMap((c) => String(c).split(','))
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    const where: Prisma.ArticleWhereInput = {};

    if (source) {
      const sourceStr = String(source);
      if (!VALID_SOURCES.includes(sourceStr)) {
        return res.status(400).json({ error: `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}` });
      }
      where.source = sourceStr;
    }

    if (categories.length > 0) {
      where.category = { hasSome: categories };
    }

    const pubDateFilter: { gte?: Date; lte?: Date } = {};
    if (fromDate) pubDateFilter.gte = fromDate;
    if (toDate) pubDateFilter.lte = toDate;
    if (Object.keys(pubDateFilter).length > 0) {
      where.pubDate = pubDateFilter;
    }

    const queryOptions: V1QueryOptions = {
      // Deterministic order (pubDate desc, id desc tiebreaker) so pages don't
      // shuffle articles that share a pubDate between requests.
      select: ARTICLE_META_SELECT,
      orderBy: [{ pubDate: 'desc' }, { id: 'desc' }],
      take: parsedPageSize,
      skip: (parsedPage - 1) * parsedPageSize,
      where,
    };

    const [articles, total] = await Promise.all([
      prisma.article.findMany(queryOptions),
      prisma.article.count({ where }),
    ]);

    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({
      data: articles.map((a) => ({
        id: a.id,
        title: a.title,
        summary: a.description,
        source: a.source,
        category: a.category,
        url: a.link,
        published_at: a.pubDate,
      })),
      meta: {
        page: parsedPage,
        page_size: parsedPageSize,
        total,
        has_more: parsedPage * parsedPageSize < total,
      },
    });
  } catch (error) {
    logger.error(error, 'Failed to fetch articles');
    res.status(500).json({ error: 'Failed to retrieve articles' });
  }
});

export default router;
