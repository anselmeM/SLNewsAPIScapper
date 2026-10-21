/**
 * Published-date provenance.
 *
 * A news row's `pubDate`/`publishedAt` is never fabricated silently: every parse
 * records *why* the stored date was chosen. The internal app still needs rows
 * with unusable dates, so `missing` rows are stored (dated `now`) and excluded
 * only from the sellable `/v1` feeds.
 */
export type PubDateSource = 'published' | 'clamped' | 'missing';

export interface ParsedPublishedDate {
  /** Always a valid Date: the parsed value, the clamped value, or `now`. */
  date: Date;
  source: PubDateSource;
  /** Publisher's original string, trimmed; null when absent/blank. */
  raw: string | null;
}

/** Dates more than this far in the future are not trusted. */
export const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
/** Dates older than this are clamped to the floor so they cannot poison feeds. */
export const MAX_AGE_MS = 10 * 365.25 * 24 * 60 * 60 * 1000;

/**
 * Parses a raw publisher date string without ever throwing.
 *
 * - blank/missing  -> `{ date: now, source: 'missing', raw: null }`
 * - unparseable    -> `{ date: now, source: 'missing', raw }`
 * - >24h in future -> `{ date: now, source: 'clamped', raw }`
 * - >10 years old  -> `{ date: now - 10y, source: 'clamped', raw }`
 * - otherwise      -> `{ date, source: 'published', raw }`
 */
export function parsePublishedDate(raw: string | null | undefined, now: Date = new Date()): ParsedPublishedDate {
  const nowMs = now.getTime();
  const nowDate = () => new Date(nowMs);

  if (raw === null || raw === undefined) {
    return { date: nowDate(), source: 'missing', raw: null };
  }

  const trimmed = String(raw).trim();
  if (!trimmed) {
    return { date: nowDate(), source: 'missing', raw: null };
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    // Some publishers emit "Monday, 09 Oct 2026 - 12:00". Try the same lenient
    // clean-up the scraper historically used before declaring the date missing.
    const cleaned = trimmed
      .replace(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s*/i, '')
      .replace(/\s*-\s*(\d{1,2}:\d{2})/, ' $1');
    const retried = new Date(cleaned);
    if (Number.isNaN(retried.getTime())) {
      return { date: nowDate(), source: 'missing', raw: trimmed };
    }
    return classify(retried, nowMs, trimmed);
  }

  return classify(parsed, nowMs, trimmed);
}

function classify(parsed: Date, nowMs: number, raw: string): ParsedPublishedDate {
  const parsedMs = parsed.getTime();

  if (parsedMs > nowMs + MAX_FUTURE_MS) {
    return { date: new Date(nowMs), source: 'clamped', raw };
  }

  const floorMs = nowMs - MAX_AGE_MS;
  if (parsedMs < floorMs) {
    return { date: new Date(floorMs), source: 'clamped', raw };
  }

  return { date: parsed, source: 'published', raw };
}
