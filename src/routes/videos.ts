import { Router, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { runSierraLeoneVideoIngestion } from '../services/video-scraper.js';
import logger from '../logger.js';

const router = Router();

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

interface VideoQueryOptions {
  orderBy: Array<{ publishedAt: 'desc' } | { id: 'desc' }>;
  take: number;
  skip?: number;
  where?: Prisma.VideoWhereInput;
}

/**
 * @swagger
 * /api/videos:
 *   get:
 *     summary: List news videos
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
 *         description: Page number (1-based)
 *       - in: query
 *         name: channel
 *         schema:
 *           type: string
 *         description: Filter by channel title
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Filter by category (comma-separated or single)
 *     responses:
 *       200:
 *         description: Paginated list of videos
 *         headers:
 *           X-Total-Count:
 *             schema:
 *               type: integer
 *       400:
 *         description: Invalid parameters
 *       401:
 *         description: Unauthorized
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { channel, category, limit, page } = req.query;

    const parsedLimit = limit ? Number(limit) : DEFAULT_LIMIT;
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }

    const parsedPage = page ? Number(page) : 1;
    if (!Number.isInteger(parsedPage) || parsedPage < 1) {
      return res.status(400).json({ error: 'page must be a positive integer' });
    }

    const take = Math.min(parsedLimit, MAX_LIMIT);
    const where: Prisma.VideoWhereInput = {};

    if (channel) {
      where.channelTitle = { contains: String(channel), mode: 'insensitive' };
    }

    if (category) {
      const categories = String(category)
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      if (categories.length > 0) {
        where.category = { hasSome: categories };
      }
    }

    const queryOptions: VideoQueryOptions = {
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take,
      skip: (parsedPage - 1) * take,
      where,
    };

    const [videos, total] = await Promise.all([prisma.video.findMany(queryOptions), prisma.video.count({ where })]);

    res.set('X-Total-Count', String(total));
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json(videos);
  } catch (error) {
    logger.error(error, 'Failed to fetch videos');
    res.status(500).json({ error: 'Failed to retrieve videos' });
  }
});

/**
 * @swagger
 * /api/videos/sync:
 *   post:
 *     summary: Trigger manual video feed synchronization
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Ingestion result summary
 *       401:
 *         description: Unauthorized
 */
router.post('/sync', async (_req: Request, res: Response) => {
  try {
    const result = await runSierraLeoneVideoIngestion();
    res.json({
      status: 'ok',
      message: 'Video ingestion completed',
      result,
    });
  } catch (error) {
    logger.error(error, 'Manual video sync failed');
    res.status(500).json({ error: 'Video ingestion failed' });
  }
});

/**
 * @swagger
 * /api/videos/{id}:
 *   get:
 *     summary: Get video by ID or YouTube video ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Video details
 *       404:
 *         description: Video not found
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const numericId = Number(id);

    let video = null;
    if (Number.isInteger(numericId) && numericId >= 1) {
      video = await prisma.video.findUnique({ where: { id: numericId } });
    }

    if (!video) {
      video = await prisma.video.findUnique({ where: { videoId: id } });
    }

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    res.json(video);
  } catch (error) {
    logger.error(error, 'Failed to fetch video');
    res.status(500).json({ error: 'Failed to fetch video' });
  }
});

export default router;
