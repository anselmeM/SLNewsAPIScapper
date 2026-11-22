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
 * sierraleonenews, SLBC Sports, MegaMjr88) were removed rather than left to
 * return stale clips. The official SLBC channel is @slbc.sl1; the older
 * @slbctv4308 channel is dormant and must stay out of the rotation.
 */
export const SIERRA_LEONE_VIDEO_SOURCES: VideoSourceConfig[] = [
  {
    name: 'AYV Media Empire',
    channelId: 'UCAAeZ5UM1LURZSWPGhteWpw',
    category: ['National', 'News'],
    note: 'AYV primetime news and Wake Up Sierra Leone (Atom feed verified 2026-11-21).',
  },
  {
    name: 'AYV News',
    channelId: 'UCou7SVOayoBeRMKURHHjlvw',
    category: ['National', 'News'],
    note: 'AYV news desk clips (Atom feed verified 2026-11-21).',
  },
  {
    name: 'SLBC News',
    channelId: 'UCEtHh4-TrhA-4BYgoGyCONQ',
    category: ['National', 'Broadcast'],
    note: 'Official SLBC channel (@slbc.sl1), daily news bulletins.',
  },
  {
    name: 'Sierraloaded TV',
    channelId: 'UCQl4gqaPgKaBbPuiugt8AtQ',
    category: ['Sports', 'News'],
    note: 'Sierraloaded video desk: Leone Stars, AFCON, local sport.',
  },
  {
    name: 'WI YONE BLOG MEDIA SL',
    channelId: 'UC5VEDhlmBur-Vp1r6fhVQPA',
    category: ['National', 'News'],
    note: 'Community reporting and national news from Sierra Leone.',
  },
  {
    name: 'Wi Yard',
    channelId: 'UCZQRp0r2C0PTZtzzzIgWP5w',
    category: ['National', 'Politics'],
    note: 'Sierra Leone politics, governance and public affairs.',
  },
  {
    name: 'Komon-Tok',
    channelId: 'UCpVJI6NCLYC3pxaLUeu8Djw',
    category: ['Politics', 'Commentary'],
    note: 'Krio commentary on Sierra Leone current affairs.',
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
