export interface VideoSourceConfig {
  name: string;
  channelId: string;
  category: string[];
}

export const SIERRA_LEONE_VIDEO_SOURCES: VideoSourceConfig[] = [
  {
    name: 'AYV News Sierra Leone',
    channelId: 'UC6L0-X7Vb7iK2fN5iW6gZ0Q',
    category: ['National', 'News'],
  },
  {
    name: 'SLBC National TV',
    channelId: 'UCe-bL9V3nL0xT_qW0zS9w9A',
    category: ['National', 'Broadcast'],
  },
  {
    name: 'Switsalone',
    channelId: 'UCqH-wUjX5fV_1yB6uE4Q7kA',
    category: ['Culture', 'Society'],
  },
  {
    name: 'SierraLoaded',
    channelId: 'UC_sierraloaded_official',
    category: ['Entertainment', 'News'],
  },
];

export function getYouTubeFeedUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}
