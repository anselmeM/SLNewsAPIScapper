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

/**
 * Validates and parses ISO date range query parameters (from, to).
 * If `to` is a date-only string (e.g. 2026-08-07), adjusts time to 23:59:59.999 UTC.
 */
export function parseDateRange(from: unknown, to: unknown): DateRangeResult {
  const fromDate = from ? new Date(String(from)) : undefined;
  const toDate = to ? new Date(String(to)) : undefined;

  if (from && (Number.isNaN(fromDate!.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(String(from)))) {
    return { error: 'from must be a valid ISO date' };
  }
  if (to && (Number.isNaN(toDate!.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(String(to)))) {
    return { error: 'to must be a valid ISO date' };
  }
  if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
    return { error: 'from must not be after to' };
  }

  // A date-only `to` (e.g. 2026-08-07) means "end of that day", not midnight.
  if (to && toDate && /^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
    toDate.setUTCHours(23, 59, 59, 999);
  }

  return { fromDate, toDate };
}
