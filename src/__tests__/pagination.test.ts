import { describe, it, expect } from 'vitest';
import {
  parsePagination,
  encodeCursor,
  parseCursor,
  MAX_PAGE,
  MAX_PAGE_SIZE,
  MAX_SKIP,
  DEFAULT_PAGE_SIZE,
  PAGE_TOO_DEEP_ERROR,
} from '../utils/pagination.js';

describe('parsePagination', () => {
  describe('legacy clamp mode (/api)', () => {
    it('defaults page, page size and skip when nothing is supplied', () => {
      expect(parsePagination({ pageRaw: undefined, clampPageSize: true })).toEqual({
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
        skip: 0,
      });
    });

    it('computes skip from limit and page', () => {
      expect(parsePagination({ pageRaw: '2', limitRaw: '10', clampPageSize: true })).toEqual({
        page: 2,
        pageSize: 10,
        skip: 10,
      });
    });

    it('clamps limit above the maximum instead of rejecting (pinned-app compatibility)', () => {
      expect(parsePagination({ pageRaw: undefined, limitRaw: '1000', clampPageSize: true })).toEqual({
        page: 1,
        pageSize: MAX_PAGE_SIZE,
        skip: 0,
      });
    });

    it('rejects invalid limit values with the legacy message', () => {
      for (const limitRaw of ['0', '-5', '1.5', 'abc', ['1', '2']]) {
        expect(parsePagination({ pageRaw: undefined, limitRaw, clampPageSize: true })).toEqual({
          error: 'limit must be a positive integer',
        });
      }
    });

    it('rejects invalid page values', () => {
      for (const pageRaw of ['0', '-2', '1.5', 'abc', ['1', '2']]) {
        expect(parsePagination({ pageRaw, limitRaw: '20', clampPageSize: true })).toEqual({
          error: 'page must be a positive integer',
        });
      }
    });

    it('rejects pages beyond the cap', () => {
      expect(parsePagination({ pageRaw: '10001', limitRaw: '20', clampPageSize: true })).toEqual({
        error: `page must not exceed ${MAX_PAGE}`,
      });
    });

    it('rejects absurd pages as too deep instead of overflowing (previously a Prisma 500)', () => {
      for (const pageRaw of ['1000000000', '1e21', '99999999999999999999999999']) {
        expect(parsePagination({ pageRaw, limitRaw: '20', clampPageSize: true })).toEqual({
          error: PAGE_TOO_DEEP_ERROR,
        });
      }
    });

    it('guards against skips above MAX_SKIP', () => {
      // page 10002 * max page size 100 = 1,000,100 > MAX_SKIP
      expect(parsePagination({ pageRaw: '10002', pageSizeRaw: '100', clampPageSize: false })).toEqual({
        error: PAGE_TOO_DEEP_ERROR,
      });
      // exactly MAX_SKIP is still allowed (then rejected only by the page cap)
      expect(parsePagination({ pageRaw: '10001', pageSizeRaw: '100', clampPageSize: false })).toEqual({
        error: `page must not exceed ${MAX_PAGE}`,
      });
    });
  });

  describe('strict mode (/v1)', () => {
    it('defaults page and page size', () => {
      expect(parsePagination({ pageRaw: undefined, clampPageSize: false })).toEqual({
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
        skip: 0,
      });
    });

    it('accepts limit as an alias when page_size is absent', () => {
      expect(parsePagination({ pageRaw: '2', limitRaw: '5', clampPageSize: false })).toEqual({
        page: 2,
        pageSize: 5,
        skip: 5,
      });
    });

    it('prefers page_size over the limit alias', () => {
      expect(parsePagination({ pageRaw: undefined, pageSizeRaw: '3', limitRaw: '9', clampPageSize: false })).toEqual({
        page: 1,
        pageSize: 3,
        skip: 0,
      });
    });

    it('rejects page_size above the maximum', () => {
      expect(parsePagination({ pageRaw: undefined, pageSizeRaw: '101', clampPageSize: false })).toEqual({
        error: `page_size must be a positive integer up to ${MAX_PAGE_SIZE}`,
      });
    });

    it('rejects invalid page_size and invalid limit-alias values', () => {
      for (const options of [
        { pageRaw: undefined, pageSizeRaw: '0', clampPageSize: false },
        { pageRaw: undefined, pageSizeRaw: '1.5', clampPageSize: false },
        { pageRaw: undefined, pageSizeRaw: 'abc', clampPageSize: false },
        { pageRaw: undefined, limitRaw: 'abc', clampPageSize: false },
      ]) {
        expect(parsePagination(options)).toEqual({
          error: `page_size must be a positive integer up to ${MAX_PAGE_SIZE}`,
        });
      }
    });

    it('allows page exactly at the cap with the maximum page size', () => {
      expect(parsePagination({ pageRaw: String(MAX_PAGE), pageSizeRaw: '100', clampPageSize: false })).toEqual({
        page: MAX_PAGE,
        pageSize: 100,
        skip: 999_900,
      });
    });

    it('rejects pages beyond the cap', () => {
      expect(parsePagination({ pageRaw: '10001', pageSizeRaw: '20', clampPageSize: false })).toEqual({
        error: `page must not exceed ${MAX_PAGE}`,
      });
    });

    it('exposes MAX_SKIP as the hard offset bound', () => {
      expect(MAX_SKIP).toBe(1_000_000);
    });
  });
});

describe('cursors', () => {
  it('round-trips a date and id', () => {
    const date = new Date('2026-08-07T12:34:56.789Z');
    const encoded = encodeCursor(date, 42);

    expect(encoded).toBe(Buffer.from('2026-08-07T12:34:56.789Z|42', 'utf8').toString('base64url'));
    expect(parseCursor(encoded)).toEqual({ cursor: { date, id: 42 } });
  });

  it('returns an empty result when no cursor is supplied', () => {
    expect(parseCursor(undefined)).toEqual({});
  });

  it('rejects malformed cursors with one stable message', () => {
    const asCursor = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
    const invalid = [
      '',
      'not-a-cursor',
      '!!!',
      asCursor('2026-08-07T12:34:56.789Z'), // no id part
      asCursor('2026-08-07|42'), // not an ISO date-time
      asCursor('2026-02-30T00:00:00.000Z|42'), // rolled-over calendar date
      asCursor('2026-08-07T12:34:56.789Z|0'), // non-positive id
      asCursor('2026-08-07T12:34:56.789Z|-1'),
      asCursor('2026-08-07T12:34:56.789Z|1.5'),
      asCursor('2026-08-07T12:34:56.789Z|abc'),
      asCursor('part|42|extra'), // wrong shape
      `${encodeCursor(new Date('2026-08-07T00:00:00.000Z'), 1)}=`, // padded
    ];

    for (const raw of invalid) {
      expect(parseCursor(raw)).toEqual({ error: 'cursor is invalid' });
    }
  });

  it('rejects non-string cursors', () => {
    for (const raw of [42, ['a'], { cursor: 'x' }, null]) {
      expect(parseCursor(raw)).toEqual({ error: 'cursor is invalid' });
    }
  });
});
