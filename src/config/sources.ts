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
];
