import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { parseYouTubeAtomFeed, syncYouTubeChannel, runSierraLeoneVideoIngestion } from '../services/video-scraper.js';
import { prisma } from '../db.js';

vi.mock('../db.js', () => ({
  prisma: {
    video: {
      count: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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

describe('video-scraper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    });

    it('returns empty array if feed has no entries', () => {
      const emptyFeed = `<feed><title>No Entries</title></feed>`;
      const videos = parseYouTubeAtomFeed(emptyFeed);
      expect(videos).toEqual([]);
    });
  });

  describe('syncYouTubeChannel', () => {
    it('fetches feed and upserts new videos', async () => {
      (axios.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: SAMPLE_ATOM_FEED,
      });
      (prisma.video.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      const source = {
        name: 'AYV News Sierra Leone',
        channelId: 'UC6L0-X7Vb7iK2fN5iW6gZ0Q',
        category: ['National'],
      };

      const result = await syncYouTubeChannel(source);
      expect(result.ingested).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(0);
      expect(prisma.video.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { videoId: '3f4Y2N4w1bY' },
        }),
      );
    });

    it('skips existing videos', async () => {
      (axios.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: SAMPLE_ATOM_FEED,
      });
      (prisma.video.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 99 });

      const source = {
        name: 'AYV News Sierra Leone',
        channelId: 'UC6L0-X7Vb7iK2fN5iW6gZ0Q',
        category: ['National'],
      };

      const result = await syncYouTubeChannel(source);
      expect(result.ingested).toBe(0);
      expect(result.skipped).toBe(1);
      expect(prisma.video.upsert).not.toHaveBeenCalled();
    });

    it('handles network errors without throwing', async () => {
      (axios.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network error'));

      const source = {
        name: 'Failing Channel',
        channelId: 'UC_FAILING',
        category: ['News'],
      };

      const result = await syncYouTubeChannel(source);
      expect(result.errors).toBe(1);
      expect(result.ingested).toBe(0);
    });
  });

  describe('runSierraLeoneVideoIngestion', () => {
    it('processes all configured sources and aggregates stats', async () => {
      (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: SAMPLE_ATOM_FEED,
      });
      (prisma.video.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const stats = await runSierraLeoneVideoIngestion();
      expect(stats.totalIngested).toBeGreaterThanOrEqual(1);
      expect(stats.totalErrors).toBe(0);
    });
  });
});
