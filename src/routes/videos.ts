import { Router, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { runSierraLeoneVideoIngestion } from '../services/video-scraper.js';
import { parsePositiveInt } from '../utils/query.js';
import { parsePagination } from '../utils/pagination.js';
import { buildVideoWhere, parseListFilters } from '../utils/listFilters.js';
import logger from '../logger.js';

const router = Router();

const DEFAULT_VIDEO_SYNC_COOLDOWN_MS = 30_000;

// Manual sync overlap guard. Module-level state is intentional: a single API
// process should never run two ingestion cycles at once (the hourly cron is the
// normal path), and a cooldown keeps a caller from re-triggering it immediately.
let videoSyncInFlight = false;
let videoSyncCooldownUntil = 0;

function videoSyncCooldownMs(): number {
  const raw = process.env.VIDEO_SYNC_COOLDOWN_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_VIDEO_SYNC_COOLDOWN_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_VIDEO_SYNC_COOLDOWN_MS;
}

/** Test-only: clears the in-flight flag and cooldown timestamp. */
export function __resetVideoSyncState(): void {
  videoSyncInFlight = false;
  videoSyncCooldownUntil = 0;
}

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
 *           maximum: 10000
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
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Search keyword across title, description, and channel (case-insensitive)
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
    const { channel, category, limit, page, q } = req.query;

    const filters = parseListFilters({ q, category });
    if (filters.error) {
      return res.status(400).json({ error: filters.error });
    }

    // Same legacy contract as /api/news: clamp `limit`, but reject absurd pages.
    const pagination = parsePagination({ pageRaw: page, limitRaw: limit, clampPageSize: true });
    if ('error' in pagination) {
      return res.status(400).json({ error: pagination.error });
    }

    const take = pagination.pageSize;
    const where: Prisma.VideoWhereInput = {};
    const built = buildVideoWhere(where, filters, { channel });
    if (built.error) {
      return res.status(400).json({ error: built.error });
    }

    const queryOptions: VideoQueryOptions = {
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take,
      skip: pagination.skip,
      where,
    };

    const [videos, total] = await Promise.all([prisma.video.findMany(queryOptions), prisma.video.count({ where })]);

    res.set('X-Total-Count', String(total));
    res.set('Cache-Control', 'private, max-age=300');
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
  if (videoSyncInFlight) {
    res.status(409).json({ error: 'Video sync already in progress' });
    return;
  }

  const now = Date.now();
  if (now < videoSyncCooldownUntil) {
    const retryAfterSeconds = Math.max(1, Math.ceil((videoSyncCooldownUntil - now) / 1000));
    res.set('Retry-After', String(retryAfterSeconds));
    res.status(429).json({ error: 'Video sync is cooling down', retry_after_seconds: retryAfterSeconds });
    return;
  }

  videoSyncInFlight = true;
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
  } finally {
    videoSyncInFlight = false;
    videoSyncCooldownUntil = Date.now() + videoSyncCooldownMs();
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
    const numericId = parsePositiveInt(id, NaN);

    let video = null;
    if (!Number.isNaN(numericId)) {
      video = await prisma.video.findUnique({ where: { id: numericId } });
    }

    if (!video) {
      video = await prisma.video.findUnique({ where: { videoId: id } });
    }

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    res.set('Cache-Control', 'private, max-age=3600');
    res.json(video);
  } catch (error) {
    logger.error(error, 'Failed to fetch video');
    res.status(500).json({ error: 'Failed to fetch video' });
  }
});

export default router;
