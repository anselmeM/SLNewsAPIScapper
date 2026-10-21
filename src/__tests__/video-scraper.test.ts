import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { parseYouTubeAtomFeed, syncYouTubeChannel, runSierraLeoneVideoIngestion } from '../services/video-scraper.js';
import { prisma } from '../db.js';

vi.mock('../db.js', () => ({
  prisma: {
    video: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({ id: 1 }),
    },
  },
}));

vi.mock('../logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

type Mock = ReturnType<typeof vi.fn>;

const SAMPLE_ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=UC6L0-X7Vb7iK2fN5iW6gZ0Q"/>
  <id>yt:channel:UC6L0-X7Vb7iK2fN5iW6gZ0Q</id>
  <yt:channelId>UC6L0-X7Vb7iK2fN5iW6gZ0Q</yt:channelId>
  <title>AYV Media Empire</title>
  <entry>
    <id>yt:video:3f4Y2N4w1bY</id>
    <yt:videoId>3f4Y2N4w1bY</yt:videoId>
    <yt:channelId>UC6L0-X7Vb7iK2fN5iW6gZ0Q</yt:channelId>
    <title>Freetown Port Expansion Commissioned</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=3f4Y2N4w1bY"/>
    <author>
      <name>AYV News</name>
      <uri>https://www.youtube.com/channel/UC6L0-X7Vb7iK2fN5iW6gZ0Q</uri>
    </author>
    <published>2026-09-01T10:00:00+00:00</published>
    <updated>2026-09-01T11:00:00+00:00</updated>
    <media:group>
      <media:title>Freetown Port Expansion Commissioned</media:title>
      <media:thumbnail url="https://i.ytimg.com/vi/3f4Y2N4w1bY/hqdefault.jpg" width="480" height="360"/>
      <media:description>Presidential briefing on container terminal.</media:description>
    </media:group>
  </entry>
</feed>`;

function atomFeedWithTwoVideos(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>Test Channel</title>
  <yt:channelId>UC_TEST_CHANNEL</yt:channelId>
  <entry>
    <id>yt:video:videoOne111</id>
    <yt:videoId>videoOne111</yt:videoId>
    <title>First Video</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=videoOne111"/>
    <published>2026-09-01T10:00:00+00:00</published>
    <media:group><media:thumbnail url="https://i.ytimg.com/vi/videoOne111/hqdefault.jpg"/></media:group>
  </entry>
  <entry>
    <id>yt:video:videoTwo222</id>
    <yt:videoId>videoTwo222</yt:videoId>
    <title>Second Video</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=videoTwo222"/>
    <published>2026-09-02T10:00:00+00:00</published>
    <media:group><media:thumbnail url="https://i.ytimg.com/vi/videoTwo222/hqdefault.jpg"/></media:group>
  </entry>
</feed>`;
}

const TEST_SOURCE = {
  name: 'AYV News Sierra Leone',
  channelId: 'UC6L0-X7Vb7iK2fN5iW6gZ0Q',
  category: ['National'],
};

function videoMocks() {
  return {
    findMany: prisma.video.findMany as Mock,
    upsert: prisma.video.upsert as Mock,
  };
}

describe('video-scraper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (axios.get as Mock).mockReset();
    const { findMany, upsert } = videoMocks();
    findMany.mockReset().mockResolvedValue([]);
    upsert.mockReset().mockResolvedValue({ id: 1 });
  });

  describe('parseYouTubeAtomFeed', () => {
    it('parses valid YouTube Atom XML into video objects', () => {
      const videos = parseYouTubeAtomFeed(SAMPLE_ATOM_FEED, ['National', 'News']);
      expect(videos).toHaveLength(1);
      expect(videos[0]).toEqual({
        videoId: '3f4Y2N4w1bY',
        title: 'Freetown Port Expansion Commissioned',
        url: 'https://www.youtube.com/watch?v=3f4Y2N4w1bY',
        description: 'Presidential briefing on container terminal.',
        thumbnailUrl: 'https://i.ytimg.com/vi/3f4Y2N4w1bY/hqdefault.jpg',
        channelId: 'UC6L0-X7Vb7iK2fN5iW6gZ0Q',
        channelTitle: 'AYV News',
        publishedAt: new Date('2026-09-01T10:00:00+00:00'),
        publishedAtSource: 'published',
        publishedAtRaw: '2026-09-01T10:00:00+00:00',
        category: ['National', 'News'],
      });
    });

    it('handles feeds with missing media descriptions or author tags gracefully', () => {
      const minimalFeed = `
        <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
          <title>Fallback Channel</title>
          <entry>
            <id>yt:video:abc12345678</id>
            <title>Minimal Video</title>
            <published>2026-09-02T12:00:00Z</published>
          </entry>
        </feed>
      `;

      const videos = parseYouTubeAtomFeed(minimalFeed, ['General']);
      expect(videos).toHaveLength(1);
      expect(videos[0].videoId).toBe('abc12345678');
      expect(videos[0].title).toBe('Minimal Video');
      expect(videos[0].description).toBeNull();
      expect(videos[0].channelTitle).toBe('Fallback Channel');
      expect(videos[0].thumbnailUrl).toBe('https://i.ytimg.com/vi/abc12345678/hqdefault.jpg');
      expect(videos[0].publishedAtSource).toBe('published');
      expect(videos[0].publishedAtRaw).toBe('2026-09-02T12:00:00Z');
    });

    it('marks entries without a published date as missing instead of fabricating one', () => {
      const undatedFeed = `
        <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
          <title>Undated Channel</title>
          <entry>
            <id>yt:video:undated12345</id>
            <title>Undated Video</title>
          </entry>
        </feed>
      `;

      const now = new Date('2026-10-21T12:00:00.000Z');
      const videos = parseYouTubeAtomFeed(undatedFeed, ['News'], now);

      expect(videos).toHaveLength(1);
      expect(videos[0].publishedAtSource).toBe('missing');
      expect(videos[0].publishedAtRaw).toBeNull();
      expect(videos[0].publishedAt).toEqual(now);
    });

    it('marks unparseable published dates as missing with the raw value retained', () => {
      const invalidFeed = `
        <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
          <title>Invalid Channel</title>
          <entry>
            <id>yt:video:invalid12345</id>
            <title>Invalid Video</title>
            <published>not-a-date</published>
          </entry>
        </feed>
      `;

      const now = new Date('2026-10-21T12:00:00.000Z');
      const videos = parseYouTubeAtomFeed(invalidFeed, ['News'], now);

      expect(videos[0].publishedAtSource).toBe('missing');
      expect(videos[0].publishedAtRaw).toBe('not-a-date');
      expect(videos[0].publishedAt).toEqual(now);
    });

    it('clamps implausible future published dates to now', () => {
      const futureFeed = `
        <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
          <title>Future Channel</title>
          <entry>
            <id>yt:video:future12345</id>
            <title>Future Video</title>
            <published>2099-01-01T00:00:00Z</published>
          </entry>
        </feed>
      `;

      const now = new Date('2026-10-21T12:00:00.000Z');
      const videos = parseYouTubeAtomFeed(futureFeed, ['News'], now);

      expect(videos[0].publishedAtSource).toBe('clamped');
      expect(videos[0].publishedAtRaw).toBe('2099-01-01T00:00:00Z');
      expect(videos[0].publishedAt).toEqual(now);
    });

    it('returns empty array if feed has no entries', () => {
      const emptyFeed = `<feed><title>No Entries</title></feed>`;
      const videos = parseYouTubeAtomFeed(emptyFeed);
      expect(videos).toEqual([]);
    });
  });

  describe('syncYouTubeChannel', () => {
    it('batches existing-video lookup into one findMany and upserts new videos', async () => {
      vi.mocked(axios.get).mockResolvedValueOnce({ data: SAMPLE_ATOM_FEED });

      const result = await syncYouTubeChannel(TEST_SOURCE);

      expect(result.ingested).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(0);
      expect(videoMocks().findMany).toHaveBeenCalledTimes(1);
      expect(videoMocks().findMany).toHaveBeenCalledWith({
        where: { videoId: { in: ['3f4Y2N4w1bY'] } },
        select: { videoId: true },
      });
      expect(videoMocks().upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { videoId: '3f4Y2N4w1bY' } }));
      const create = (videoMocks().upsert.mock.calls[0][0] as { create: Record<string, unknown> }).create;
      expect(create.publishedAtSource).toBe('published');
      expect(create.publishedAtRaw).toBe('2026-09-01T10:00:00+00:00');
    });

    it('skips existing videos found by the batched lookup', async () => {
      vi.mocked(axios.get).mockResolvedValueOnce({ data: SAMPLE_ATOM_FEED });
      videoMocks().findMany.mockResolvedValueOnce([{ videoId: '3f4Y2N4w1bY' }]);

      const result = await syncYouTubeChannel(TEST_SOURCE);

      expect(result.ingested).toBe(0);
      expect(result.skipped).toBe(1);
      expect(videoMocks().upsert).not.toHaveBeenCalled();
    });

    it('uses one findMany for a multi-video channel and upserts each new video', async () => {
      vi.mocked(axios.get).mockResolvedValueOnce({ data: atomFeedWithTwoVideos() });

      const result = await syncYouTubeChannel(TEST_SOURCE);

      expect(result.ingested).toBe(2);
      expect(result.skipped).toBe(0);
      expect(videoMocks().findMany).toHaveBeenCalledTimes(1);
      expect(videoMocks().findMany).toHaveBeenCalledWith({
        where: { videoId: { in: ['videoOne111', 'videoTwo222'] } },
        select: { videoId: true },
      });
      expect(videoMocks().upsert).toHaveBeenCalledTimes(2);
    });

    it('handles network errors without throwing', async () => {
      vi.mocked(axios.get).mockRejectedValueOnce(new Error('Network error'));

      const result = await syncYouTubeChannel({ name: 'Failing Channel', channelId: 'UC_FAILING', category: ['News'] });

      expect(result.errors).toBe(1);
      expect(result.ingested).toBe(0);
    });
  });

  describe('runSierraLeoneVideoIngestion', () => {
    it('processes all configured sources and aggregates stats', async () => {
      vi.mocked(axios.get).mockResolvedValue({ data: SAMPLE_ATOM_FEED });

      const stats = await runSierraLeoneVideoIngestion();

      expect(stats.totalIngested).toBeGreaterThanOrEqual(1);
      expect(stats.totalErrors).toBe(0);
    });

    it('skips all channels when the deadline has already passed', async () => {
      vi.mocked(axios.get).mockResolvedValue({ data: SAMPLE_ATOM_FEED });

      const stats = await runSierraLeoneVideoIngestion(Date.now() - 1000);

      expect(axios.get).not.toHaveBeenCalled();
      expect(videoMocks().findMany).not.toHaveBeenCalled();
      expect(stats).toEqual({ totalIngested: 0, totalSkipped: 0, totalErrors: 0 });
    });
  });
});
