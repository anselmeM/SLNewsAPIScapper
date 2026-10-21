/**
 * Shared query validation and parameter parsing utilities.
 */

/**
 * Parses a value into a positive integer (>= 1). Returns fallback if undefined,
 * or NaN if the value is not a valid positive integer.
 */
export function parsePositiveInt(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : NaN;
}

/**
 * Validates and sanitizes a keyword search query parameter `q`.
 */
export function parseSearchQuery(q: unknown, maxLen = 100): { term?: string; error?: string } {
  if (q === undefined) return {};
  const term = String(q).trim();
  if (term.length > maxLen) {
    return { error: `q search term must not exceed ${maxLen} characters` };
  }
  return { term: term.length > 0 ? term : undefined };
}

/**
 * Parses query parameter categories into a normalized array of trimmed category strings.
 * Supports both repeated query params (?category=a&category=b) and comma-delimited strings (?category=a,b).
 */
export function parseCategories(category: unknown): string[] {
  if (category === undefined) return [];
  const rawCategories = Array.isArray(category) ? category : [category];
  return rawCategories
    .flatMap((c) => String(c).split(','))
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

export interface DateRangeResult {
  fromDate?: Date;
  toDate?: Date;
  error?: string;
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_PREFIX_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ]/;

/**
 * Parses a strict ISO date or ISO date-time.
 *
 * The calendar date itself is validated through a UTC round-trip, so impossible
 * values (`2026-02-30`, `2026-13-01`, `2026-00-10`) are rejected instead of
 * being silently rolled over by `Date`. Date-only values are UTC midnight;
 * full date-time values keep their original instant.
 */
function parseIsoDate(value: unknown, label: 'from' | 'to'): { date?: Date; error?: string } {
  const raw = String(value);
  const match = DATE_ONLY_PATTERN.exec(raw) ?? DATE_PREFIX_PATTERN.exec(raw);
  if (!match) return { error: `${label} must be a valid ISO date` };

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { error: `${label} must be a valid ISO date` };
  }

  const utcMidnight = new Date(Date.UTC(year, month - 1, day));
  if (
    utcMidnight.getUTCFullYear() !== year ||
    utcMidnight.getUTCMonth() !== month - 1 ||
    utcMidnight.getUTCDate() !== day
  ) {
    return { error: `${label} must be a valid ISO date` };
  }

  if (DATE_ONLY_PATTERN.test(raw)) return { date: utcMidnight };

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return { error: `${label} must be a valid ISO date` };
  return { date: parsed };
}

/**
 * Validates and parses ISO date range query parameters (from, to).
 *
 * A date-only `to` (e.g. 2026-08-07) means "end of that day" (23:59:59.999 UTC),
 * and that adjustment happens before the from > to comparison so a same-day
 * window such as `from=2026-08-07T12:00:00Z&to=2026-08-07` is valid.
 */
export function parseDateRange(from: unknown, to: unknown): DateRangeResult {
  if (!from && !to) return { fromDate: undefined, toDate: undefined };

  let fromDate: Date | undefined;
  if (from) {
    const parsed = parseIsoDate(from, 'from');
    if (parsed.error) return { error: parsed.error };
    fromDate = parsed.date;
  }

  let toDate: Date | undefined;
  if (to) {
    const parsed = parseIsoDate(to, 'to');
    if (parsed.error || !parsed.date) {
      return { error: parsed.error ?? 'to must be a valid ISO date' };
    }
    toDate = parsed.date;

    // Date-only `to` means inclusive end of that UTC day. Adjust before the
    // ordering check so a same-day time window is not rejected.
    if (DATE_ONLY_PATTERN.test(String(to))) {
      toDate.setUTCHours(23, 59, 59, 999);
    }
  }

  if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
    return { error: 'from must not be after to' };
  }

  return { fromDate, toDate };
}
