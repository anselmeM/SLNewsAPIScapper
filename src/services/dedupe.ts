/**
 * Cross-source duplicate detection.
 *
 * The same story arrives from several feeds with different links and slightly
 * different headlines. Exact-link dedupe cannot see that, so ingestion compares
 * canonicalised links and title token overlap. A story already seen in the last
 * 24 hours is kept once; the first publisher wins.
 */
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source']);

export function canonicalizeUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hash = '';
    url.hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    for (const key of Array.from(url.searchParams.keys())) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return raw.trim();
  }
}

export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleSimilarity(a: string, b: string): number {
  const left = new Set(
    normaliseTitle(a)
      .split(' ')
      .filter((word) => word.length > 2),
  );
  const right = new Set(
    normaliseTitle(b)
      .split(' ')
      .filter((word) => word.length > 2),
  );
  if (left.size === 0 || right.size === 0) return 0;
  let common = 0;
  for (const word of left) if (right.has(word)) common += 1;
  return common / Math.max(left.size, right.size);
}

export interface ExistingStory {
  link: string;
  title: string;
}

export class DedupeIndex {
  private readonly links = new Set<string>();
  private readonly titles: string[] = [];

  constructor(existing: ExistingStory[] = []) {
    for (const story of existing) this.add(story.link, story.title);
  }

  add(link: string, title: string): void {
    this.links.add(canonicalizeUrl(link));
    this.titles.push(title);
  }

  isDuplicate(link: string, title: string, threshold = 0.85): boolean {
    if (this.links.has(canonicalizeUrl(link))) return true;
    return this.titles.some((existing) => titleSimilarity(existing, title) >= threshold);
  }
}
