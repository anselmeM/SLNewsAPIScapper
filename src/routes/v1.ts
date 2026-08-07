import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { SIERRA_LEONE_SOURCES } from '../config/sources.js';
import logger from '../logger.js';

const router = Router();

const VALID_SOURCES = SIERRA_LEONE_SOURCES.map((s) => s.name);
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

// The sellable contract is metadata + summary only (link + summary model):
// headline, summary, source, pub date, image, and the link back to the
// publisher. Full article text (paragraphs) is never exposed to API customers.
const ARTICLE_META_SELECT = {
  id: true,
  title: true,
  description: true,
  author: true,
  category: true,
  imageUrl: true,
  pubDate: true,
  source: true,
  link: true,
} as const;

interface V1QueryOptions {
  select: typeof ARTICLE_META_SELECT;
  orderBy: Array<{ pubDate: 'desc' } | { id: 'desc' }>;
  take: number;
  skip?: number;
  where?: { source: string };
}

/**
 * @swagger
 * /v1/news:
 *   get:
 *     summary: List news articles (versioned contract)
 *     description: |
 *       The business-facing contract. Returns a `{ data, meta }` envelope so
 *       the payload shape is stable and pagination is self-describing.
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
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data, meta]
 *               properties:
 *                 data:
 *                   type: array
 *                   description: Article metadata only (link + summary model — full text is never exposed)
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       title:
 *                         type: string
 *                       description:
 *                         type: string
 *                       author:
 *                         type: string
 *                       category:
 *                         type: array
 *                         items:
 *                           type: string
 *                       imageUrl:
 *                         type: string
 *                         nullable: true
 *                       pubDate:
 *                         type: string
 *                         format: date-time
 *                       source:
 *                         type: string
 *                       link:
 *                         type: string
 *                 meta:
 *                   type: object
 *                   required: [page, limit, total, totalPages]
 *                   properties:
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     total:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *       400:
 *         description: Invalid parameters
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
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

    const queryOptions: V1QueryOptions = {
      // Deterministic order (pubDate desc, id desc tiebreaker) so pages don't
      // shuffle articles that share a pubDate between requests.
      select: ARTICLE_META_SELECT,
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

    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({
      data: articles,
      meta: {
        page: parsedPage,
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    });
  } catch (error) {
    logger.error(error, 'Failed to fetch articles');
    res.status(500).json({ error: 'Failed to retrieve articles' });
  }
});

export default router;
