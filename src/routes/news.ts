import { Router, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { SIERRA_LEONE_SOURCES } from '../config/sources.js';
import { parsePositiveInt, parseSearchQuery } from '../utils/query.js';
import logger from '../logger.js';

const router = Router();

const VALID_SOURCES = SIERRA_LEONE_SOURCES.map((s) => s.name);
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

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

    const parsedLimit = parsePositiveInt(limit, DEFAULT_LIMIT);
    if (Number.isNaN(parsedLimit)) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }

    const parsedPage = parsePositiveInt(page, 1);
    if (Number.isNaN(parsedPage)) {
      return res.status(400).json({ error: 'page must be a positive integer' });
    }

    const { term: searchTerm, error: searchError } = parseSearchQuery(q);
    if (searchError) {
      return res.status(400).json({ error: searchError });
    }

    const take = Math.min(parsedLimit, MAX_LIMIT);

    const where: Prisma.ArticleWhereInput = {};

    if (source) {
      const sourceStr = String(source);
      if (!VALID_SOURCES.includes(sourceStr)) {
        return res.status(400).json({ error: `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}` });
      }
      where.source = sourceStr;
    }

    if (searchTerm && searchTerm.length > 0) {
      where.OR = [
        { title: { contains: searchTerm, mode: 'insensitive' } },
        { description: { contains: searchTerm, mode: 'insensitive' } },
      ];
    }

    const queryOptions: NewsQueryOptions = {
      // Deterministic order (pubDate desc, id desc tiebreaker) so pages don't
      // shuffle articles that share a pubDate between requests.
      orderBy: [{ pubDate: 'desc' }, { id: 'desc' }],
      take,
      skip: (parsedPage - 1) * take,
      where: Object.keys(where).length > 0 ? where : undefined,
    };

    const [articles, total] = await Promise.all([
      prisma.article.findMany(queryOptions),
      prisma.article.count({ where: queryOptions.where }),
    ]);

    res.set('X-Total-Count', String(total));
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
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
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    res.json(article);
  } catch (error) {
    logger.error(error, 'Failed to fetch article');
    res.status(500).json({ error: 'Failed to fetch article' });
  }
});

export default router;
