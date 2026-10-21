import { describe, it, expect } from 'vitest';
import { parsePublishedDate, MAX_AGE_MS, MAX_FUTURE_MS } from '../utils/dates.js';

const NOW = new Date('2026-10-21T12:00:00.000Z');

describe('parsePublishedDate', () => {
  it('trusts a parseable in-range date and keeps the raw value', () => {
    const raw = '2026-09-01T10:30:00+00:00';
    const parsed = parsePublishedDate(raw, NOW);

    expect(parsed).toEqual({ date: new Date('2026-09-01T10:30:00+00:00'), source: 'published', raw });
  });

  it('treats missing/blank input as missing with a null raw value', () => {
    for (const raw of [undefined, null, '', '   ']) {
      const parsed = parsePublishedDate(raw, NOW);
      expect(parsed).toEqual({ date: new Date(NOW.getTime()), source: 'missing', raw: null });
    }
  });

  it('never throws on unparseable input and marks it missing with the raw retained', () => {
    const parsed = parsePublishedDate('not-a-real-date', NOW);

    expect(parsed).toEqual({ date: new Date(NOW.getTime()), source: 'missing', raw: 'not-a-real-date' });
  });

  it('clamps dates more than 24h in the future to now', () => {
    const raw = new Date(NOW.getTime() + MAX_FUTURE_MS + 60_000).toISOString();
    const parsed = parsePublishedDate(raw, NOW);

    expect(parsed.source).toBe('clamped');
    expect(parsed.date).toEqual(new Date(NOW.getTime()));
    expect(parsed.raw).toBe(raw);
  });

  it('trusts dates within the 24h future tolerance', () => {
    const raw = new Date(NOW.getTime() + MAX_FUTURE_MS - 60_000).toISOString();
    const parsed = parsePublishedDate(raw, NOW);

    expect(parsed.source).toBe('published');
    expect(parsed.date).toEqual(new Date(raw));
    expect(parsed.raw).toBe(raw);
  });

  it('clamps dates older than 10 years to the age floor', () => {
    const raw = new Date(NOW.getTime() - MAX_AGE_MS - 86_400_000).toISOString();
    const parsed = parsePublishedDate(raw, NOW);

    expect(parsed.source).toBe('clamped');
    expect(parsed.date).toEqual(new Date(NOW.getTime() - MAX_AGE_MS));
    expect(parsed.raw).toBe(raw);
  });

  it('keeps dates just inside the 10-year window as published', () => {
    const raw = new Date(NOW.getTime() - MAX_AGE_MS + 86_400_000).toISOString();
    const parsed = parsePublishedDate(raw, NOW);

    expect(parsed.source).toBe('published');
    expect(parsed.date).toEqual(new Date(raw));
  });

  it('retries the lenient weekday/-time publisher format before giving up', () => {
    const raw = 'Monday, 05 Oct 2026 - 12:30';
    const parsed = parsePublishedDate(raw, NOW);

    expect(parsed.source).toBe('published');
    expect(parsed.raw).toBe(raw);
    expect(Number.isNaN(parsed.date.getTime())).toBe(false);
  });

  it('always returns a valid Date', () => {
    for (const raw of [undefined, '', 'garbage', '2099-01-01T00:00:00Z', '1900-01-01T00:00:00Z']) {
      const parsed = parsePublishedDate(raw, NOW);
      expect(Number.isNaN(parsed.date.getTime())).toBe(false);
    }
  });
});
