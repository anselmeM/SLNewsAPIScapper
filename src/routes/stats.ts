import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import logger from '../logger.js';
import { positiveIntFromEnv, runtimeMetrics } from '../observability.js';
import { sourceHealthSnapshot } from '../services/source-health.js';
import { imageBackfillSnapshot } from '../services/image-metrics.js';

const router = Router();

const DEFAULT_FRESHNESS_MAX_AGE_MS = 7_200_000; // 2 hours

/** Maximum acceptable ingestion lag before freshness is flagged stale (env-configurable). */
function freshnessMaxAgeMs(): number {
  return positiveIntFromEnv(process.env.FRESHNESS_MAX_AGE_MS, DEFAULT_FRESHNESS_MAX_AGE_MS);
}

interface Freshness {
  latest_ingested_at: string | null;
  lag_seconds: number | null;
  stale: boolean;
}

/**
 * Freshness of a dataset, based on the latest `createdAt` (ingestion time).
 *
 * No ingested rows => `latest_ingested_at` and `lag_seconds` are null and
 * `stale` is true: absence of data is not evidence that the pipeline is healthy,
 * so an empty/first-run database must page an operator instead of looking fresh.
 */
function freshness(latestIngestedAt: Date | null | undefined): Freshness {
  if (!latestIngestedAt) {
    return { latest_ingested_at: null, lag_seconds: null, stale: true };
  }
  const lagMs = Math.max(0, Date.now() - latestIngestedAt.getTime());
  return {
    latest_ingested_at: latestIngestedAt.toISOString(),
    lag_seconds: Math.round(lagMs / 1000),
    stale: lagMs > freshnessMaxAgeMs(),
  };
}

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
    const [
      totalArticles,
      articlesBySource,
      latestArticle,
      missingDateArticles,
      emptyContentArticles,
      totalVideos,
      videosByChannel,
      latestVideo,
      missingDateVideos,
    ] = await Promise.all([
      prisma.article.count(),
      prisma.article.groupBy({
        by: ['source'],
        _count: { source: true },
      }),
      prisma.article.findFirst({
        orderBy: { pubDate: 'desc' },
        select: { pubDate: true, createdAt: true },
      }),
      prisma.article.count({ where: { pubDateSource: 'missing' } }),
      prisma.article.count({ where: { contentSource: { in: ['empty', 'summary'] } } }),
      prisma.video.count(),
      prisma.video.groupBy({
        by: ['channelTitle'],
        _count: { channelTitle: true },
      }),
      prisma.video.findFirst({
        orderBy: { publishedAt: 'desc' },
        select: { publishedAt: true, createdAt: true },
      }),
      prisma.video.count({ where: { publishedAtSource: 'missing' } }),
    ]);

    const articleSourceCounts: Record<string, number> = {};
    for (const group of articlesBySource) {
      articleSourceCounts[group.source] = group._count.source;
    }

    const videoChannelCounts: Record<string, number> = {};
    for (const group of videosByChannel) {
      videoChannelCounts[group.channelTitle] = group._count.channelTitle;
    }

    res.set('Cache-Control', 'private, max-age=60');
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      runtime: runtimeMetrics(),
      image_backfill: imageBackfillSnapshot(),
      articles: {
        total: totalArticles,
        by_source: articleSourceCounts,
        latest_pub_date: latestArticle?.pubDate ?? null,
        latest_ingested_at: latestArticle?.createdAt ?? null,
        missing_date: missingDateArticles,
        empty_content: emptyContentArticles,
      },
      videos: {
        total: totalVideos,
        by_channel: videoChannelCounts,
        latest_published_at: latestVideo?.publishedAt ?? null,
        latest_ingested_at: latestVideo?.createdAt ?? null,
        missing_date: missingDateVideos,
      },
      freshness: {
        articles: freshness(latestArticle?.createdAt),
        videos: freshness(latestVideo?.createdAt),
      },
    });
  } catch (error) {
    logger.error(error, 'Failed to retrieve stats');
    res.status(500).json({ error: 'Failed to retrieve system statistics' });
  }
});

/**
 * @swagger
 * /api/stats/sources:
 *   get:
 *     summary: Per-source ingestion health and backoff state
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Health of each feed seen by the worker
 */
router.get('/sources', (_req: Request, res: Response) => {
  res.json({ updated_at: new Date().toISOString(), sources: sourceHealthSnapshot() });
});

export default router;
