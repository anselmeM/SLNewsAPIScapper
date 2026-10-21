import { Router, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { SIERRA_LEONE_SOURCES } from '../config/sources.js';
import { parsePositiveInt } from '../utils/query.js';
import { parsePagination } from '../utils/pagination.js';
import { buildArticleWhere, parseListFilters } from '../utils/listFilters.js';
import logger from '../logger.js';

const router = Router();

const VALID_SOURCES = SIERRA_LEONE_SOURCES.map((s) => s.name);

interface NewsQueryOptions {
  orderBy: Array<{ pubDate: 'desc' } | { id: 'desc' }>;
  take: number;
  skip?: number;
  where?: Prisma.ArticleWhereInput;
}

/**
 * @swagger
 * /api/news:
 *   get:
 *     summary: List news articles
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 10000
 *           default: 1
 *         description: Page number for pagination (1-based)
 *       - in: query
 *         name: source
 *         schema:
 *           type: string
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Search keyword across title and description (case-insensitive)
 *     responses:
 *       200:
 *         description: Paginated list of articles
 *         headers:
 *           X-Total-Count:
 *             schema:
 *               type: integer
 *             description: Total number of articles matching the query
 *       400:
 *         description: Invalid parameters
 *       401:
 *         description: Unauthorized
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { source, limit, page, q } = req.query;

    // /api/news supports only `q`; `category`/`from`/`to` stay ignored here.
    const filters = parseListFilters({ q });
    if (filters.error) {
      return res.status(400).json({ error: filters.error });
    }

    // Legacy contract: `limit` above MAX_PAGE_SIZE is still clamped silently
    // (the pinned app depends on it), but an absurd `page` is now a 400 instead
    // of an enormous OFFSET / Prisma validation 500.
    const pagination = parsePagination({ pageRaw: page, limitRaw: limit, clampPageSize: true });
    if ('error' in pagination) {
      return res.status(400).json({ error: pagination.error });
    }

    const take = pagination.pageSize;

    const where: Prisma.ArticleWhereInput = {};
    const built = buildArticleWhere(where, filters, { source, validSources: VALID_SOURCES });
    if (built.error) {
      return res.status(400).json({ error: built.error });
    }

    const queryOptions: NewsQueryOptions = {
      // Deterministic order (pubDate desc, id desc tiebreaker) so pages don't
      // shuffle articles that share a pubDate between requests.
      orderBy: [{ pubDate: 'desc' }, { id: 'desc' }],
      take,
      skip: pagination.skip,
      where: Object.keys(where).length > 0 ? where : undefined,
    };

    const [articles, total] = await Promise.all([
      prisma.article.findMany(queryOptions),
      prisma.article.count({ where: queryOptions.where }),
    ]);

    res.set('X-Total-Count', String(total));
    // Authenticated data: shared caches must not serve it. `s-maxage` would only
    // apply to shared caches, which `private` excludes, so it is intentionally absent.
    res.set('Cache-Control', 'private, max-age=300');
    res.json(articles);
  } catch (error) {
    logger.error(error, 'Failed to fetch articles');
    res.status(500).json({ error: 'Failed to retrieve articles' });
  }
});

/**
 * @swagger
 * /api/news/{id}:
 *   get:
 *     summary: Get article by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Full article details
 *       400:
 *         description: Invalid ID
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Article not found
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const articleId = parsePositiveInt(id, NaN);
    if (Number.isNaN(articleId)) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }

    const article = await prisma.article.findUnique({
      where: { id: articleId },
    });

    if (!article) return res.status(404).json({ error: 'Article not found' });
    res.set('Cache-Control', 'private, max-age=3600');
    res.json(article);
  } catch (error) {
    logger.error(error, 'Failed to fetch article');
    res.status(500).json({ error: 'Failed to fetch article' });
  }
});

export default router;
