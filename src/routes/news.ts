import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { SIERRA_LEONE_SOURCES } from '../config/sources.js';
import logger from '../logger.js';

const router = Router();

const VALID_SOURCES = SIERRA_LEONE_SOURCES.map((s) => s.name);
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

interface NewsQueryOptions {
  orderBy: Array<{ pubDate: 'desc' } | { id: 'desc' }>;
  take: number;
  skip?: number;
  where?: { source: string };
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
    const { source, limit, page } = req.query;

    const parsedLimit = limit ? Number(limit) : DEFAULT_LIMIT;
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }

    const parsedPage = page ? Number(page) : 1;
    if (!Number.isInteger(parsedPage) || parsedPage < 1) {
      return res.status(400).json({ error: 'page must be a positive integer' });
    }

    const take = Math.min(parsedLimit, MAX_LIMIT);

    const queryOptions: NewsQueryOptions = {
      // Deterministic order (pubDate desc, id desc tiebreaker) so pages don't
      // shuffle articles that share a pubDate between requests.
      orderBy: [{ pubDate: 'desc' }, { id: 'desc' }],
      take,
      skip: (parsedPage - 1) * take,
    };

    if (source) {
      const sourceStr = String(source);
      if (!VALID_SOURCES.includes(sourceStr)) {
        return res.status(400).json({ error: `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}` });
      }
      queryOptions.where = { source: sourceStr };
    }

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
    const articleId = Number(id);
    if (!Number.isInteger(articleId) || articleId < 1) {
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
