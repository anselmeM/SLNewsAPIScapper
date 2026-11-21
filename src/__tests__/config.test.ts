import { describe, it, expect } from 'vitest';
import { SIERRA_LEONE_SOURCES } from '../config/sources.js';

describe('News sources configuration', () => {
  it('has sources defined', () => {
    expect(SIERRA_LEONE_SOURCES.length).toBeGreaterThan(0);
  });

  it('each source has required fields', () => {
    for (const source of SIERRA_LEONE_SOURCES) {
      expect(source.name).toBeTruthy();
      expect(source.feedUrl).toBeTruthy();
      expect(source.contentSelector).toBeTruthy();
      expect(source.feedUrl.startsWith('http')).toBe(true);
    }
  });

  it('source names are unique', () => {
    const names = SIERRA_LEONE_SOURCES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('includes the verified local outlets from the 2026-11-21 source check', () => {
    const names = SIERRA_LEONE_SOURCES.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(['The Sierra Leone Telegraph', 'Sierraloaded', 'The Calabash', 'AYV News', 'Cocorioko']),
    );
  });
});
