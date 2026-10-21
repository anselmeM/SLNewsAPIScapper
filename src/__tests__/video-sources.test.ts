import { describe, expect, it } from 'vitest';
import { SIERRA_LEONE_VIDEO_SOURCES, getYouTubeFeedUrl } from '../config/video-sources.js';

describe('SIERRA_LEONE_VIDEO_SOURCES', () => {
  it('uses real 24-character YouTube channel ids', () => {
    for (const source of SIERRA_LEONE_VIDEO_SOURCES) {
      expect(source.channelId, source.name).toMatch(/^UC[0-9A-Za-z_-]{22}$/);
    }
  });

  it('has no duplicate channels and names every one', () => {
    const ids = SIERRA_LEONE_VIDEO_SOURCES.map((s) => s.channelId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const source of SIERRA_LEONE_VIDEO_SOURCES) {
      expect(source.name.trim().length).toBeGreaterThan(0);
      expect(source.category.length).toBeGreaterThan(0);
    }
  });

  it('builds the public Atom feed URL', () => {
    expect(getYouTubeFeedUrl('UCAAeZ5UM1LURZSWPGhteWpw')).toBe(
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCAAeZ5UM1LURZSWPGhteWpw',
    );
  });
});
