import { describe, it, expect } from 'vitest';
import { parsePositiveInt, parseSearchQuery, parseCategories, parseDateRange } from '../utils/query.js';

describe('query utilities', () => {
  describe('parsePositiveInt', () => {
    it('returns fallback if value is undefined', () => {
      expect(parsePositiveInt(undefined, 20)).toBe(20);
    });

    it('returns valid integer if positive', () => {
      expect(parsePositiveInt('5', 20)).toBe(5);
      expect(parsePositiveInt(10, 20)).toBe(10);
    });

    it('returns NaN if value is zero or negative', () => {
      expect(Number.isNaN(parsePositiveInt('0', 20))).toBe(true);
      expect(Number.isNaN(parsePositiveInt('-5', 20))).toBe(true);
    });

    it('returns NaN if value is not an integer', () => {
      expect(Number.isNaN(parsePositiveInt('abc', 20))).toBe(true);
      expect(Number.isNaN(parsePositiveInt('12.34', 20))).toBe(true);
    });
  });

  describe('parseSearchQuery', () => {
    it('returns empty object if q is undefined', () => {
      expect(parseSearchQuery(undefined)).toEqual({});
    });

    it('trims whitespace and returns term', () => {
      expect(parseSearchQuery('  freetown  ')).toEqual({ term: 'freetown' });
    });

    it('returns undefined term if blank string', () => {
      expect(parseSearchQuery('   ')).toEqual({ term: undefined });
    });

    it('returns error if term exceeds maximum length', () => {
      const longTerm = 'a'.repeat(101);
      expect(parseSearchQuery(longTerm, 100)).toEqual({
        error: 'q search term must not exceed 100 characters',
      });
    });
  });

  describe('parseCategories', () => {
    it('returns empty array when undefined', () => {
      expect(parseCategories(undefined)).toEqual([]);
    });

    it('handles single category', () => {
      expect(parseCategories('Politics')).toEqual(['Politics']);
    });

    it('handles comma-separated categories', () => {
      expect(parseCategories('Politics, Economy, Health')).toEqual(['Politics', 'Economy', 'Health']);
    });

    it('handles array of categories', () => {
      expect(parseCategories(['Politics', 'Economy'])).toEqual(['Politics', 'Economy']);
    });

    it('handles mixed array of comma-separated strings and trims whitespace', () => {
      expect(parseCategories(['Politics, Economy', ' Sports '])).toEqual(['Politics', 'Economy', 'Sports']);
    });
  });

  describe('parseDateRange', () => {
    it('returns empty date bounds when undefined', () => {
      expect(parseDateRange(undefined, undefined)).toEqual({ fromDate: undefined, toDate: undefined });
    });

    it('parses valid ISO dates', () => {
      const { fromDate, toDate, error } = parseDateRange('2026-01-01', '2026-01-10');
      expect(error).toBeUndefined();
      expect(fromDate).toBeInstanceOf(Date);
      expect(toDate).toBeInstanceOf(Date);
      expect(toDate?.getUTCHours()).toBe(23);
      expect(toDate?.getUTCMinutes()).toBe(59);
    });

    it('rejects invalid from date', () => {
      expect(parseDateRange('not-a-date', undefined)).toEqual({
        error: 'from must be a valid ISO date',
      });
    });

    it('rejects invalid to date', () => {
      expect(parseDateRange(undefined, 'invalid')).toEqual({
        error: 'to must be a valid ISO date',
      });
    });

    it('rejects inverted date order', () => {
      expect(parseDateRange('2026-01-15', '2026-01-01')).toEqual({
        error: 'from must not be after to',
      });
    });

    it('rejects impossible calendar dates instead of rolling them over', () => {
      for (const value of ['2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00']) {
        expect(parseDateRange(value, undefined)).toEqual({ error: 'from must be a valid ISO date' });
        expect(parseDateRange(undefined, value)).toEqual({ error: 'to must be a valid ISO date' });
      }
    });

    it('rejects impossible calendar dates inside date-time strings', () => {
      expect(parseDateRange('2026-02-30T10:00:00Z', undefined)).toEqual({
        error: 'from must be a valid ISO date',
      });
      expect(parseDateRange(undefined, '2026-13-01T10:00:00Z')).toEqual({
        error: 'to must be a valid ISO date',
      });
    });

    it('accepts date-only and full ISO date-time values', () => {
      expect(parseDateRange('2026-08-07', undefined).fromDate?.toISOString()).toBe('2026-08-07T00:00:00.000Z');
      expect(parseDateRange('2026-08-07T12:34:56.789Z', undefined).fromDate?.toISOString()).toBe(
        '2026-08-07T12:34:56.789Z',
      );
      expect(parseDateRange(undefined, '2026-08-08T01:00:00+02:00').toDate?.toISOString()).toBe(
        '2026-08-07T23:00:00.000Z',
      );
    });

    it('applies the date-only end-of-day adjustment before the from>to check', () => {
      const { fromDate, toDate, error } = parseDateRange('2026-08-07T12:00:00Z', '2026-08-07');

      expect(error).toBeUndefined();
      expect(fromDate?.toISOString()).toBe('2026-08-07T12:00:00.000Z');
      expect(toDate?.toISOString()).toBe('2026-08-07T23:59:59.999Z');
    });

    it('still rejects a genuinely inverted full date-time range', () => {
      expect(parseDateRange('2026-08-08T00:00:00Z', '2026-08-07T23:59:59.999Z')).toEqual({
        error: 'from must not be after to',
      });
    });

    it('accepts a same-day date-only window', () => {
      const { fromDate, toDate, error } = parseDateRange('2026-08-07', '2026-08-07');

      expect(error).toBeUndefined();
      expect(fromDate?.toISOString()).toBe('2026-08-07T00:00:00.000Z');
      expect(toDate?.toISOString()).toBe('2026-08-07T23:59:59.999Z');
    });
  });
});
