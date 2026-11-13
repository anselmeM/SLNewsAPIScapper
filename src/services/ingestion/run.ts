import { prisma } from '../../db.js';
import { DedupeIndex } from '../dedupe.js';
import logger from '../../logger.js';
import { runSierraLeoneVideoIngestion } from '../video-scraper.js';
import { backfillImages, repairMissingContent } from './backfill.js';
import { ingestFeeds } from './feed.js';
import { scrapeTelegraphFromSitemap } from './sitemap.js';
import type { IngestionOptions, IngestionRunContext } from './types.js';

const DEFAULT_INGESTION_DEADLINE_MS = 45 * 60 * 1000;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function runSierraLeoneIngestion(options: IngestionOptions = {}) {
  logger.info('Starting Sierra Leone Ingestion Cycle');

  const configuredDeadlineMs = readPositiveIntEnv('INGESTION_DEADLINE_MS', DEFAULT_INGESTION_DEADLINE_MS);
  const deadlineAt = options.deadlineAt ?? Date.now() + configuredDeadlineMs;
  if (Date.now() >= deadlineAt) {
    logger.warn({ deadlineAt }, 'Ingestion deadline already reached; skipping run');
    return;
  }

  const context: IngestionRunContext = {
    deadlineAt,
    startedAt: Date.now(),
    imageFetches: 0,
    contentRepairs: { deadlineAt, startedAt: Date.now(), repairs: 0 },
  };

  // One index for the whole run. Items accepted from a source are added after
  // that source is processed, so near-identical headlines in the SAME feed are
  // preserved while the next publisher still loses to the first.
  const recentStories = await prisma.article.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    select: { link: true, title: true },
  });
  const dedupeIndex = new DedupeIndex(recentStories);

  await ingestFeeds(context, dedupeIndex);

  logger.info('Article Ingestion Cycle Complete');

  // Bounded sweep for rows stored without a body that this run's feeds did not see.
  await repairMissingContent(context.contentRepairs);
  if (!options.skipImageBackfill) await backfillImages(deadlineAt);

  // Sitemap fallback: catch articles the RSS feed may have missed.
  await scrapeTelegraphFromSitemap(deadlineAt);

  // Video feeds: ingest latest video broadcasts & shorts.
  await runSierraLeoneVideoIngestion(deadlineAt);

  logger.info('Full Ingestion Cycle Complete');
}
