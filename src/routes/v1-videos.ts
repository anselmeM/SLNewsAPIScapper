import { Router, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import logger from '../logger.js';

const router = Router();

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE = 10_000;

function parsePositiveInt(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : NaN;
}

/**
 * @swagger
 * /v1/videos:
 *   get:
 *     summary: List news videos (versioned business contract)
 *     description: Returns paginated video news metadata and playback URLs for Sierra Leone broadcasters.
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
 *         description: Number of videos per page
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination (1-based)
 *       - in: query
 *         name: channel
 *         schema:
 *           type: string
 *         description: Filter by channel title
 *       - in: query
 *         name: category
 *         schema:
 *           type: array
 *           items:
 *             type: string
 *         style: form
 *         explode: true
 *         description: Filter by category (repeat param or comma-separated)
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date
 *         description: Earliest published date (ISO)
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date
 *         description: Latest published date (ISO)
 *     responses:
 *       200:
 *         description: Paginated video metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data, meta]
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [id, video_id, title, summary, source, category, url, thumbnail_url, published_at]
 *                 meta:
 *                   type: object
 *                   required: [page, page_size, total, has_more]
 *       400:
 *         description: Invalid parameters
 *       401:
 *         description: Unauthorized
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { category, channel, page, page_size, limit, from, to } = req.query;

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
    if (to && toDate && /^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
      toDate.setUTCHours(23, 59, 59, 999);
    }

    const rawCategories = category === undefined ? [] : Array.isArray(category) ? category : [category];
    const categories = rawCategories
      .flatMap((c) => String(c).split(','))
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    const where: Prisma.VideoWhereInput = {};

    if (channel) {
      where.channelTitle = { contains: String(channel), mode: 'insensitive' };
    }

    if (categories.length > 0) {
      where.category = { hasSome: categories };
    }

    const publishedAtFilter: { gte?: Date; lte?: Date } = {};
    if (fromDate) publishedAtFilter.gte = fromDate;
    if (toDate) publishedAtFilter.lte = toDate;
    if (Object.keys(publishedAtFilter).length > 0) {
      where.publishedAt = publishedAtFilter;
    }

    const [videos, total] = await Promise.all([
      prisma.video.findMany({
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: parsedPageSize,
        skip: (parsedPage - 1) * parsedPageSize,
        where,
      }),
      prisma.video.count({ where }),
    ]);

    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({
      data: videos.map((v) => ({
        id: v.id,
        video_id: v.videoId,
        title: v.title,
        summary: v.description,
        source: v.channelTitle,
        category: v.category,
        url: v.url,
        thumbnail_url: v.thumbnailUrl,
        published_at: v.publishedAt,
      })),
      meta: {
        page: parsedPage,
        page_size: parsedPageSize,
        total,
        has_more: parsedPage * parsedPageSize < total,
      },
    });
  } catch (error) {
    logger.error(error, 'Failed to fetch videos');
    res.status(500).json({ error: 'Failed to retrieve videos' });
  }
});

export default router;
