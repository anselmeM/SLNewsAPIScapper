export interface NewsSourceConfig {
  name: string;
  feedUrl: string;
  contentSelector: string;
}

export const SIERRA_LEONE_SOURCES: NewsSourceConfig[] = [
  {
    name: 'The Sierra Leone Telegraph',
    feedUrl: 'https://www.thesierraleonetelegraph.com/feed/',
    contentSelector: '.entry-content p, .entry-content h2, .entry-content h3',
  },
  {
    name: 'Politico SL',
    feedUrl: 'https://politicosl.com/rss.xml',
    contentSelector: '.node__content p, .field--name-body p',
  },
  {
    name: 'Concord Times',
    feedUrl: 'https://sierraleoneconcordtimes.com/feed/',
    contentSelector: '.entry-content p, .post-content p',
  },
  // News and video source list checked 2026-11-21. All entries below are
  // WordPress sites using the standard /feed endpoint (verified live).
  // Awoko (https://awokonewspapersl.com/feed) is deliberately absent: it
  // answers a Cloudflare challenge (HTTP 403) to server-side clients, so it
  // cannot be ingested until we have a compliant workaround.
  {
    name: 'Sierraloaded',
    feedUrl: 'https://sierraloaded.sl/feed',
    contentSelector: '.entry-content p, .post-content p, article p',
  },
  {
    name: 'The Calabash',
    feedUrl: 'https://thecalabashnewspaper.com/feed',
    contentSelector: '.entry-content p, .post-content p, article p',
  },
  {
    name: 'AYV News',
    feedUrl: 'https://ayvnews.com/feed',
    contentSelector: '.entry-content p, .post-content p, article p',
  },
  {
    name: 'Cocorioko',
    feedUrl: 'https://cocorioko.net/feed',
    contentSelector: '.entry-content p, .post-content p, article p',
  },
];
