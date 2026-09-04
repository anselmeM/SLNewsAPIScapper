import * as cheerio from 'cheerio';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { prisma } from '../db.js';
import { SIERRA_LEONE_VIDEO_SOURCES, VideoSourceConfig, getYouTubeFeedUrl } from '../config/video-sources.js';
import logger from '../logger.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const RETRY_DELAY_MS = 1000;
const MAX_RETRIES = 3;

async function fetchWithRetry(
  url: string,
  options: AxiosRequestConfig = {},
  retries = MAX_RETRIES,
): Promise<AxiosResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, options);
    } catch (err) {
      lastError = err;
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status !== undefined && status < 500 && status !== 429) throw err;
      if (attempt < retries) {
        const delayMs = process.env.NODE_ENV === 'test' ? 0 : RETRY_DELAY_MS * 2 ** (attempt - 1);
        logger.warn({ url, attempt, err }, 'Video feed request failed; retrying');
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

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
      url: linkHref,
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

export async function syncYouTubeChannel(source: VideoSourceConfig): Promise<{
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
    const { data } = await fetchWithRetry(feedUrl, {
      timeout: 10000,
      headers: { 'User-Agent': USER_AGENT },
    });

    const videos = parseYouTubeAtomFeed(String(data), source.category);
    logger.info({ channel: source.name, count: videos.length }, 'Found videos in YouTube feed');

    for (const v of videos) {
      try {
        const existing = await prisma.video.findUnique({
          where: { videoId: v.videoId },
          select: { id: true },
        });

        if (existing) {
          skipped++;
          continue;
        }

        await prisma.video.upsert({
          where: { videoId: v.videoId },
          update: {
            title: v.title,
            description: v.description,
            thumbnailUrl: v.thumbnailUrl,
          },
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

export async function runSierraLeoneVideoIngestion(): Promise<{
  totalIngested: number;
  totalSkipped: number;
  totalErrors: number;
}> {
  logger.info('Starting Sierra Leone Video Ingestion Cycle');

  let totalIngested = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const source of SIERRA_LEONE_VIDEO_SOURCES) {
    const { ingested, skipped, errors } = await syncYouTubeChannel(source);
    totalIngested += ingested;
    totalSkipped += skipped;
    totalErrors += errors;

    // Small politeness pause between feeds
    if (process.env.NODE_ENV !== 'test') {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  logger.info({ totalIngested, totalSkipped, totalErrors }, 'Sierra Leone Video Ingestion Cycle Complete');

  return { totalIngested, totalSkipped, totalErrors };
}
