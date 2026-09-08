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
  });
});
