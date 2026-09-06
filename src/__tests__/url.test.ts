import { describe, it, expect } from 'vitest';
import { normalizeArticleUrl } from '../utils/url.js';

describe('normalizeArticleUrl', () => {
  it('strips utm and tracking parameters', () => {
    const input =
      'https://www.thesierraleonetelegraph.com/port-expansion/?utm_source=twitter&utm_medium=social&fbclid=IwAR2xyz';
    const output = normalizeArticleUrl(input);
    expect(output).toBe('https://www.thesierraleonetelegraph.com/port-expansion');
  });

  it('strips trailing slashes from pathnames', () => {
    const input = 'https://politicosl.com/article-123/';
    const output = normalizeArticleUrl(input);
    expect(output).toBe('https://politicosl.com/article-123');
  });

  it('preserves root path', () => {
    const input = 'https://politicosl.com/';
    const output = normalizeArticleUrl(input);
    expect(output).toBe('https://politicosl.com/');
  });

  it('preserves non-tracking query parameters', () => {
    const input = 'https://www.youtube.com/watch?v=3f4Y2N4w1bY&utm_source=share';
    const output = normalizeArticleUrl(input);
    expect(output).toBe('https://www.youtube.com/watch?v=3f4Y2N4w1bY');
  });

  it('strips hash fragments', () => {
    const input = 'https://sierraleoneconcordtimes.com/story#comments';
    const output = normalizeArticleUrl(input);
    expect(output).toBe('https://sierraleoneconcordtimes.com/story');
  });

  it('returns trimmed string for invalid URLs', () => {
    expect(normalizeArticleUrl('not-a-url')).toBe('not-a-url');
    expect(normalizeArticleUrl('')).toBe('');
  });
});
