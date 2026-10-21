import { Router, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { parseSearchQuery, parseCategories, parseDateRange } from '../utils/query.js';
import { parsePagination, parseCursor, encodeCursor } from '../utils/pagination.js';
import logger from '../logger.js';

const router = Router();

/**
 * @swagger
 * /v1/videos:
 *   get:
 *     summary: List news videos (versioned business contract)
 *     description: |
 *       Returns paginated video news metadata and playback URLs for Sierra Leone
 *       broadcasters. Videos whose published date could not be parsed are
 *       excluded from this sellable feed; they remain visible on the internal
 *       `/api/videos` surface.
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
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Search keyword across title, description, and channel (case-insensitive)
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
 *         description: Unauthorized
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { category, channel, page, page_size, limit, from, to, q, cursor } = req.query;

    const { term: searchTerm, error: searchError } = parseSearchQuery(q);
    if (searchError) {
      return res.status(400).json({ error: searchError });
    }

    if (cursor !== undefined && page !== undefined) {
      return res.status(400).json({ error: 'use either page or cursor, not both' });
    }

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

    const { fromDate, toDate, error: dateError } = parseDateRange(from, to);
    if (dateError) {
      return res.status(400).json({ error: dateError });
    }

    const categories = parseCategories(category);

    // Sellable feeds never surface rows whose published date could not be
    // parsed; the pinned internal app still sees them via /api/videos.
    const where: Prisma.VideoWhereInput = { publishedAtSource: { not: 'missing' } };

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

    const searchOr: Prisma.VideoWhereInput[] | undefined =
      searchTerm && searchTerm.length > 0
        ? [
            { title: { contains: searchTerm, mode: 'insensitive' } },
            { description: { contains: searchTerm, mode: 'insensitive' } },
            { channelTitle: { contains: searchTerm, mode: 'insensitive' } },
          ]
        : undefined;

    if (parsedCursor) {
      // Keyset predicate for the (publishedAt desc, id desc) order, combined
      // with the search predicate as AND siblings so neither clobbers the other.
      const keyset: Prisma.VideoWhereInput = {
        OR: [
          { publishedAt: { lt: parsedCursor.date } },
          { publishedAt: parsedCursor.date, id: { lt: parsedCursor.id } },
        ],
      };
      where.AND = searchOr ? [{ OR: searchOr }, keyset] : [keyset];
    } else if (searchOr) {
      where.OR = searchOr;
    }

    const toMetaVideo = (v: {
      id: number;
      videoId: string;
      title: string;
      description: string | null;
      channelTitle: string;
      category: string[];
      url: string;
      thumbnailUrl: string | null;
      publishedAt: Date;
    }) => ({
      id: v.id,
      video_id: v.videoId,
      title: v.title,
      summary: v.description,
      source: v.channelTitle,
      category: v.category,
      url: v.url,
      thumbnail_url: v.thumbnailUrl,
      published_at: v.publishedAt,
    });

    // Cursor mode: no count query. One extra row decides has_more/next_cursor.
    if (parsedCursor) {
      const rows = await prisma.video.findMany({
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: parsedPageSize + 1,
        where,
      });
      const hasMore = rows.length > parsedPageSize;
      const dataRows = hasMore ? rows.slice(0, parsedPageSize) : rows;
      const lastRow = dataRows[dataRows.length - 1];
      const nextCursor = hasMore && lastRow ? encodeCursor(lastRow.publishedAt, lastRow.id) : null;

      res.set('Cache-Control', 'private, max-age=300');
      return res.json({
        data: dataRows.map(toMetaVideo),
        meta: {
          page: null,
          page_size: parsedPageSize,
          total: null,
          has_more: hasMore,
          next_cursor: nextCursor,
        },
      });
    }

    const [videos, total] = await Promise.all([
      prisma.video.findMany({
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: parsedPageSize,
        skip: pagination.skip,
        where,
      }),
      prisma.video.count({ where }),
    ]);

    const hasMore = parsedPage * parsedPageSize < total;
    const lastVideo = videos[videos.length - 1];
    // Page mode can still bootstrap cursor pagination: return the keyset
    // position of the last row so a client can switch to `cursor=`.
    const nextCursor = hasMore && lastVideo ? encodeCursor(lastVideo.publishedAt, lastVideo.id) : null;

    res.set('Cache-Control', 'private, max-age=300');
    res.json({
      data: videos.map(toMetaVideo),
      meta: {
        page: parsedPage,
        page_size: parsedPageSize,
        total,
        has_more: hasMore,
        next_cursor: nextCursor,
      },
    });
  } catch (error) {
    logger.error(error, 'Failed to fetch videos');
    res.status(500).json({ error: 'Failed to retrieve videos' });
  }
});

export default router;
