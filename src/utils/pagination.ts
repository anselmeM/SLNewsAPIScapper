/**
 * Shared offset pagination parsing plus opaque keyset cursors.
 *
 * Offset pagination is kept for the legacy `/api` routes (the pinned app uses
 * it), but the window is bounded: an absurd page must be a 400, never an
 * expensive OFFSET or a Prisma integer-overflow 500. New sellable consumers
 * should use the `/v1` cursor instead, which does not need an exact count.
 */
import { parsePositiveInt } from './query.js';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE = 10_000;
export const MAX_SKIP = 1_000_000;
export const PAGE_TOO_DEEP_ERROR = 'page is too deep; use cursor pagination or a smaller page';

export interface PaginationOptions {
  pageRaw: unknown;
  pageSizeRaw?: unknown;
  limitRaw?: unknown;
  /**
   * Legacy `/api` behaviour clamps `limit` above 100 instead of rejecting it,
   * because the SLNews app is pinned to those routes. `/v1` keeps the strict
   * 400 contract.
   */
  clampPageSize: boolean;
}

export interface Pagination {
  page: number;
  pageSize: number;
  skip: number;
}

export type PaginationResult = Pagination | { error: string };

export function parsePagination({
  pageRaw,
  pageSizeRaw,
  limitRaw,
  clampPageSize,
}: PaginationOptions): PaginationResult {
  // `limit` is a legacy alias for `page_size`; the explicit page_size wins.
  const usingLimitAlias = pageSizeRaw === undefined;
  const sizeRaw = usingLimitAlias ? limitRaw : pageSizeRaw;

  let pageSize = parsePositiveInt(sizeRaw, DEFAULT_PAGE_SIZE);
  if (Number.isNaN(pageSize)) {
    return {
      error:
        clampPageSize && usingLimitAlias
          ? 'limit must be a positive integer'
          : `page_size must be a positive integer up to ${MAX_PAGE_SIZE}`,
    };
  }

  if (clampPageSize) {
    pageSize = Math.min(pageSize, MAX_PAGE_SIZE);
  } else if (pageSize > MAX_PAGE_SIZE) {
    return { error: `page_size must be a positive integer up to ${MAX_PAGE_SIZE}` };
  }

  const page = parsePositiveInt(pageRaw, 1);
  if (Number.isNaN(page)) {
    return { error: 'page must be a positive integer' };
  }

  const skip = (page - 1) * pageSize;
  // Guard before the page cap so a huge-but-parseable page (e.g. 1e21) is
  // rejected here rather than reaching Prisma, which would throw a
  // validation error and surface as a 500.
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(skip) || skip > MAX_SKIP) {
    return { error: PAGE_TOO_DEEP_ERROR };
  }
  if (page > MAX_PAGE) {
    return { error: `page must not exceed ${MAX_PAGE}` };
  }

  return { page, pageSize, skip };
}

export interface Cursor {
  date: Date;
  id: number;
}

export interface CursorResult {
  cursor?: Cursor;
  error?: string;
}

const CURSOR_ERROR = 'cursor is invalid';
const CANONICAL_ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Opaque keyset cursor: `base64url(<ISO date>|<id>)`. */
export function encodeCursor(date: Date, id: number): string {
  return Buffer.from(`${date.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/**
 * Strictly parses a cursor produced by `encodeCursor`. Anything malformed is
 * rejected with one stable message so callers cannot distinguish why a cursor
 * failed (and cannot smuggle arbitrary strings into the keyset predicate).
 */
export function parseCursor(raw: unknown): CursorResult {
  if (raw === undefined) return {};
  if (typeof raw !== 'string' || raw.length === 0 || !BASE64URL.test(raw)) {
    return { error: CURSOR_ERROR };
  }

  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return { error: CURSOR_ERROR };
  }

  // Reject non-canonical encodings (Buffer.from is lenient about invalid input).
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== raw) {
    return { error: CURSOR_ERROR };
  }

  const parts = decoded.split('|');
  if (parts.length !== 2) return { error: CURSOR_ERROR };

  const [datePart, idPart] = parts;
  if (!CANONICAL_ISO_DATE.test(datePart)) return { error: CURSOR_ERROR };

  const date = new Date(datePart);
  // Round-trip the date so rolled-over calendar values (e.g. Feb 30) are invalid.
  if (Number.isNaN(date.getTime()) || date.toISOString() !== datePart) {
    return { error: CURSOR_ERROR };
  }

  if (!/^[1-9]\d*$/.test(idPart)) return { error: CURSOR_ERROR };
  const id = Number(idPart);
  if (!Number.isSafeInteger(id) || id < 1) return { error: CURSOR_ERROR };

  return { cursor: { date, id } };
}
