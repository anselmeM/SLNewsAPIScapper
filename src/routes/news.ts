import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { SIERRA_LEONE_SOURCES } from '../config/sources.js';
import logger from '../logger.js';

const router = Router();

const VALID_SOURCES = SIERRA_LEONE_SOURCES.map((s) => s.name);
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

interface NewsQueryOptions {
  orderBy: { pubDate: 'desc' | 'asc' };
  take: number;
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
 *         name: source
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Paginated list of articles
 *       400:
 *         description: Invalid parameters
 *       401:
 *         description: Unauthorized
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { source, limit } = req.query;

    const parsedLimit = limit ? Number(limit) : DEFAULT_LIMIT;
    if (isNaN(parsedLimit) || parsedLimit < 1) {
      return res.status(400).json({ error: 'limit must be a positive number' });
    }

    const queryOptions: NewsQueryOptions = {
      orderBy: { pubDate: 'desc' },
      take: Math.min(parsedLimit, MAX_LIMIT),
    };

    if (source) {
      const sourceStr = String(source);
      if (!VALID_SOURCES.includes(sourceStr)) {
        return res.status(400).json({ error: `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}` });
      }
      queryOptions.where = { source: sourceStr };
    }

    const articles = await prisma.article.findMany(queryOptions);
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
    if (isNaN(articleId)) {
      return res.status(400).json({ error: 'id must be a number' });
    }

    const article = await prisma.article.findUnique({
      where: { id: articleId },
    });

    if (!article) return res.status(404).json({ error: 'Article not found' });
    res.json(article);
  } catch (error) {
    logger.error(error, 'Failed to fetch article');
    res.status(500).json({ error: 'Failed to fetch article' });
  }
});

export default router;
