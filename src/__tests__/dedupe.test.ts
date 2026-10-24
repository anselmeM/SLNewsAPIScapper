import { describe, expect, it } from 'vitest';
import { DedupeIndex, canonicalizeUrl, titleSimilarity } from '../services/dedupe.js';

describe('cross-source dedupe', () => {
  it('canonicalises tracking params, www, fragments and trailing slashes', () => {
    expect(canonicalizeUrl('https://www.bbc.com/news/story/?utm_source=x&fbclid=1#top')).toBe(
      'https://bbc.com/news/story',
    );
  });

  it('matches near-identical syndicated headlines', () => {
    expect(
      titleSimilarity('Sierra Leone parliament passes 2027 budget', 'Sierra Leone Parliament Passes 2027 Budget!'),
    ).toBeGreaterThan(0.85);
  });

  it('keeps genuinely different stories apart', () => {
    expect(titleSimilarity('Sierra Leone parliament passes budget', 'Lakers beat Nuggets in overtime')).toBeLessThan(
      0.3,
    );
  });

  it('flags a duplicate reached through a different link', () => {
    const index = new DedupeIndex([{ link: 'https://awoko.org/story/123', title: 'Leone Stars arrive in Morocco' }]);
    expect(index.isDuplicate('https://www.bbc.com/sport/story', 'Leone Stars arrive in Morocco')).toBe(true);
    expect(index.isDuplicate('https://bbc.com/news/other', 'Bo Rangers win derby')).toBe(false);
  });
});
