import * as cheerio from 'cheerio';
import { prisma } from '../db.js';
import { SIERRA_LEONE_VIDEO_SOURCES, VideoSourceConfig, getYouTubeFeedUrl } from '../config/video-sources.js';
import { normalizeArticleUrl } from '../utils/url.js';
import { fetchWithRetry, USER_AGENT, sleep } from '../utils/http.js';
import logger from '../logger.js';

export interface ParsedVideo {
  videoId: string;
  title: string;
  url: string;
  description: string | null;
  thumbnailUrl: string | null;
  channelId: string;
  channelTitle: string;
  publishedAt: Date;
  category: string[];
}

export function parseYouTubeAtomFeed(xml: string, defaultCategory: string[] = []): ParsedVideo[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const feedChannelTitle = $('feed > title').text().trim() || $('author > name').first().text().trim();
  const feedChannelId = $('yt\\:channelId').first().text().trim() || '';

  const videos: ParsedVideo[] = [];

  $('entry').each((_, el) => {
    const entry = $(el);
    const videoId =
      entry.find('yt\\:videoId').text().trim() ||
      entry
        .find('id')
        .text()
        .replace(/^yt:video:/, '')
        .trim();

    if (!videoId) return;

    const title = entry.find('title').text().trim() || 'Untitled Video';
    const linkHref = entry.find('link[rel="alternate"]').attr('href') || `https://www.youtube.com/watch?v=${videoId}`;
    const publishedText = entry.find('published').text().trim() || entry.find('updated').text().trim();
    const publishedAt = publishedText ? new Date(publishedText) : new Date();
    const channelTitle = entry.find('author > name').text().trim() || feedChannelTitle || 'YouTube Channel';
    const channelId = entry.find('yt\\:channelId').text().trim() || feedChannelId;

    const mediaGroup = entry.find('media\\:group');
    const description = mediaGroup.find('media\\:description').text().trim() || null;
    const thumbnail =
      mediaGroup.find('media\\:thumbnail').attr('url') || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    videos.push({
      videoId,
      title: title.slice(0, 500),
      url: normalizeArticleUrl(linkHref),
      description: description ? description.slice(0, 2000) : null,
      thumbnailUrl: thumbnail,
      channelId,
      channelTitle: channelTitle.slice(0, 200),
      publishedAt: isNaN(publishedAt.getTime()) ? new Date() : publishedAt,
      category: defaultCategory,
    });
  });

  return videos;
}

export async function syncYouTubeChannel(
  source: VideoSourceConfig,
  deadlineAt?: number,
): Promise<{
  ingested: number;
  skipped: number;
  errors: number;
}> {
  let ingested = 0;
  let skipped = 0;
  let errors = 0;

  const feedUrl = getYouTubeFeedUrl(source.channelId);
  logger.info({ channel: source.name, feedUrl }, 'Syncing YouTube channel feed');

  try {
    const { data } = await fetchWithRetry(
      feedUrl,
      { timeout: 10000, headers: { 'User-Agent': USER_AGENT } },
      deadlineAt === undefined ? {} : { deadlineMs: deadlineAt },
    );

    const videos = parseYouTubeAtomFeed(String(data), source.category);
    logger.info({ channel: source.name, count: videos.length }, 'Found videos in YouTube feed');

    // One batched lookup for the whole channel instead of a findUnique per video.
    const existingVideoIds = new Set<string>();
    if (videos.length > 0) {
      const existingVideos = await prisma.video.findMany({
        where: { videoId: { in: videos.map((v) => v.videoId) } },
        select: { videoId: true },
      });
      for (const video of existingVideos) existingVideoIds.add(video.videoId);
    }

    for (const v of videos) {
      try {
        if (existingVideoIds.has(v.videoId)) {
          skipped++;
          continue;
        }

        // Only new videos reach this upsert, so the update branch stays empty:
        // if an overlapping run created the row first, this is a no-op.
        await prisma.video.upsert({
          where: { videoId: v.videoId },
          update: {},
          create: {
            videoId: v.videoId,
            title: v.title,
            url: v.url,
            description: v.description,
            thumbnailUrl: v.thumbnailUrl,
            channelId: v.channelId || source.channelId,
            channelTitle: v.channelTitle || source.name,
            publishedAt: v.publishedAt,
            category: v.category,
          },
        });

        existingVideoIds.add(v.videoId);
        ingested++;
      } catch (upsertError) {
        errors++;
        logger.warn({ videoId: v.videoId, error: upsertError }, 'Failed to upsert video');
      }
    }
  } catch (feedError) {
    errors++;
    logger.error({ channel: source.name, error: feedError }, 'Failed to fetch YouTube feed');
  }

  return { ingested, skipped, errors };
}

export async function runSierraLeoneVideoIngestion(deadlineAt?: number): Promise<{
  totalIngested: number;
  totalSkipped: number;
  totalErrors: number;
}> {
  logger.info('Starting Sierra Leone Video Ingestion Cycle');

  let totalIngested = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const source of SIERRA_LEONE_VIDEO_SOURCES) {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      logger.warn(
        { channel: source.name, deadlineAt },
        'Ingestion deadline reached; skipping remaining video channels',
      );
      break;
    }

    const { ingested, skipped, errors } = await syncYouTubeChannel(source, deadlineAt);
    totalIngested += ingested;
    totalSkipped += skipped;
    totalErrors += errors;

    // Small politeness pause between feeds
    await sleep(500);
  }

  logger.info({ totalIngested, totalSkipped, totalErrors }, 'Sierra Leone Video Ingestion Cycle Complete');

  return { totalIngested, totalSkipped, totalErrors };
}
