import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import logger from '../logger.js';

const router = Router();

/**
 * @swagger
 * /api/stats:
 *   get:
 *     summary: Aggregated metrics and database freshness stats
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Real-time statistics across articles and video feeds
 *       401:
 *         description: Unauthorized
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const [totalArticles, articlesBySource, latestArticle, totalVideos, videosByChannel, latestVideo] =
      await Promise.all([
        prisma.article.count(),
        prisma.article.groupBy({
          by: ['source'],
          _count: { source: true },
        }),
        prisma.article.findFirst({
          orderBy: { pubDate: 'desc' },
          select: { pubDate: true, createdAt: true },
        }),
        prisma.video.count(),
        prisma.video.groupBy({
          by: ['channelTitle'],
          _count: { channelTitle: true },
        }),
        prisma.video.findFirst({
          orderBy: { publishedAt: 'desc' },
          select: { publishedAt: true, createdAt: true },
        }),
      ]);

    const articleSourceCounts: Record<string, number> = {};
    for (const group of articlesBySource) {
      articleSourceCounts[group.source] = group._count.source;
    }

    const videoChannelCounts: Record<string, number> = {};
    for (const group of videosByChannel) {
      videoChannelCounts[group.channelTitle] = group._count.channelTitle;
    }

    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      articles: {
        total: totalArticles,
        by_source: articleSourceCounts,
        latest_pub_date: latestArticle?.pubDate ?? null,
        latest_ingested_at: latestArticle?.createdAt ?? null,
      },
      videos: {
        total: totalVideos,
        by_channel: videoChannelCounts,
        latest_published_at: latestVideo?.publishedAt ?? null,
        latest_ingested_at: latestVideo?.createdAt ?? null,
      },
    });
  } catch (error) {
    logger.error(error, 'Failed to retrieve stats');
    res.status(500).json({ error: 'Failed to retrieve system statistics' });
  }
});

export default router;
