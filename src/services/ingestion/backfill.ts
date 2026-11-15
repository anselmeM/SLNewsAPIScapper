import { prisma } from '../../db.js';
import type { ImageBackfillFailure, ImageBackfillStats } from '../image-metrics.js';
import {
  evaluateImageBackfillAlert,
  imageBackfillLimits,
  imageBackfillSnapshot,
  recordImageBackfill,
} from '../image-metrics.js';
import { getRuntimeState, putRuntimeState } from '../runtime-state.js';
import { probeAndFingerprint } from '../image-pipeline.js';
import logger from '../../logger.js';
import {
  canRepairContent,
  contentSelectorForSource,
  fetchArticlePage,
  fetchArticlePageImage,
  finalizeImageUrl,
} from './content.js';
import type { ContentRepairContext } from './types.js';

const MAX_CONTENT_REPAIRS_PER_RUN = 5;
const MAX_CONTENT_ATTEMPTS = 3;

/** Bounded sweep: fill empty images and bust stale image URLs on recent rows. */
export async function backfillImages(deadlineAt: number): Promise<void> {
  if (Date.now() >= deadlineAt) return;
  const startedAt = Date.now();
  const missingWhere = {
    imageUrl: null,
    createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
  };
  const missingTotal = await prisma.article.count({ where: missingWhere });
  const limits = imageBackfillLimits(missingTotal);
  const missing = await prisma.article.findMany({
    where: missingWhere,
    orderBy: { createdAt: 'desc' },
    take: limits.missing,
    select: { id: true, link: true },
  });
  let filled = 0;
  const failures: ImageBackfillFailure[] = [];
  for (const article of missing) {
    if (Date.now() >= deadlineAt) break;
    const pageImage = await fetchArticlePageImage(article.link);
    const final = await finalizeImageUrl(pageImage);
    if (!final) {
      failures.push({
        url: article.link,
        reason: pageImage === null ? 'no-page-image' : 'probe-rejected',
        at: Date.now(),
      });
      continue;
    }
    await prisma.article.update({ where: { id: article.id }, data: { imageUrl: final } });
    filled += 1;
  }

  const stale = await prisma.article.findMany({
    where: {
      imageUrl: { not: null },
      createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
    orderBy: { createdAt: 'desc' },
    take: limits.revalidate,
    select: { id: true, imageUrl: true },
  });
  let revalidated = 0;
  for (const article of stale) {
    if (Date.now() >= deadlineAt) break;
    if (!article.imageUrl || article.imageUrl.includes('v=')) continue;
    const probe = await probeAndFingerprint(article.imageUrl);
    if (!probe.ok) {
      failures.push({
        url: article.imageUrl,
        reason: probe.reason ?? 'probe-failed',
        at: Date.now(),
      });
      // An unsafe image is not a transient failure: clear it so the API never
      // serves a URL that the SSRF guard rejected.
      if (probe.reason === 'unsafe') {
        await prisma.article.update({ where: { id: article.id }, data: { imageUrl: null } });
      }
      continue;
    }
    if (probe.url !== article.imageUrl) {
      await prisma.article.update({ where: { id: article.id }, data: { imageUrl: probe.url } });
      revalidated += 1;
    }
  }
  const missingRemaining = Math.max(0, missingTotal - filled);
  const previous = await getRuntimeState<ImageBackfillStats>('image_backfill');
  const alertState = evaluateImageBackfillAlert({ missingRemaining, previous });
  recordImageBackfill({
    filled,
    revalidated,
    missingRemaining,
    limits,
    durationMs: Date.now() - startedAt,
    stuckRuns: alertState.stuck_runs,
    alert: alertState.alert,
    alertReason: alertState.alert_reason,
    failures,
  });
  await putRuntimeState('image_backfill', imageBackfillSnapshot());
  if (alertState.alert) {
    logger.error(
      { missingRemaining, stuckRuns: alertState.stuck_runs, reason: alertState.alert_reason },
      'Image backfill backlog is stuck',
    );
  }
  logger.info({ filled, revalidated, limits }, 'Image backfill complete');
}

/**
 * Bounded repair sweep for rows stored without a body. Runs after the feed pass
 * (which repairs candidates it happens to see) and before the sitemap walk.
 * One query, at most MAX_CONTENT_REPAIRS_PER_RUN page fetches, per-row failure
 * isolation and the shared run deadline.
 */
export async function repairMissingContent(context: ContentRepairContext): Promise<void> {
  if (!canRepairContent(context)) return;

  let candidates: Array<{ id: number; link: string; source: string }>;
  try {
    candidates = await prisma.article.findMany({
      where: {
        contentSource: { in: ['empty', 'summary'] },
        contentAttempts: { lt: MAX_CONTENT_ATTEMPTS },
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_CONTENT_REPAIRS_PER_RUN,
      select: { id: true, link: true, source: true },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load articles needing content repair');
    return;
  }

  for (const article of candidates) {
    if (!canRepairContent(context)) {
      logger.info(
        { repaired: context.repairs },
        'Content repair budget exhausted; remaining rows wait for a later run',
      );
      return;
    }

    try {
      context.repairs++;
      const page = await fetchArticlePage(article.link, contentSelectorForSource(article.source));

      if (page.paragraphs.length > 0) {
        await prisma.article.update({
          where: { id: article.id },
          data: {
            paragraphs: page.paragraphs,
            contentSource: 'page',
            contentAttempts: 0,
            lastContentAttemptAt: new Date(),
          },
        });
        logger.info({ id: article.id, link: article.link }, 'Repaired missing article content');
      } else {
        await prisma.article.update({
          where: { id: article.id },
          data: {
            contentSource: 'empty',
            contentAttempts: { increment: 1 },
            lastContentAttemptAt: new Date(),
          },
        });
        logger.warn({ id: article.id, link: article.link }, 'Content repair attempt found no body');
      }
    } catch (err) {
      logger.warn({ id: article.id, link: article.link, err }, 'Content repair failed');
    }
  }
}
