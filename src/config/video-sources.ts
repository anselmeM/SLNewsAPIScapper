export interface VideoSourceConfig {
  name: string;
  channelId: string;
  category: string[];
  /** Why this channel is in the rotation; kept for editorial clarity. */
  note?: string;
}

/**
 * Popular Sierra Leone news channels, verified against YouTube's Atom feeds.
 *
 * Each entry was resolved from its real channel and its feed was checked to
 * return recent uploads (see the video-sources test for ID-shape/uniqueness).
 * The scrape keeps the newest uploads from all of them; the API sorts by
 * `publishedAt desc`, so the rail is "newest across popular channels".
 *
 * Channels that went dormant (Swit Salone, Sierra Loaded, Salone News,
 * sierraleonenews) were removed rather than left to return stale clips.
 */
export const SIERRA_LEONE_VIDEO_SOURCES: VideoSourceConfig[] = [
  {
    name: 'AYV Media Empire',
    channelId: 'UCAAeZ5UM1LURZSWPGhteWpw',
    category: ['National', 'News'],
    note: 'AYV primetime news and Wake Up Sierra Leone.',
  },
  {
    name: 'AYV News',
    channelId: 'UCou7SVOayoBeRMKURHHjlvw',
    category: ['National', 'News'],
    note: 'AYV news desk clips.',
  },
  {
    name: 'SLBC News',
    channelId: 'UCEtHh4-TrhA-4BYgoGyCONQ',
    category: ['National', 'Broadcast'],
    note: 'State broadcaster, daily news bulletins.',
  },
  {
    name: 'Vickie Remoe',
    channelId: 'UCXMnWFC9lQVYepr4yfFjhlQ',
    category: ['Culture', 'Society'],
    note: 'Sierra Leonean documentary and culture channel.',
  },
];

export function getYouTubeFeedUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}
