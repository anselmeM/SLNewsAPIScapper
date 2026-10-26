import { describe, expect, it } from 'vitest';
import { assertSafeFetchUrl, UnsafeFetchUrlError } from '../utils/safe-url.js';

describe('scraper fetch URL guard', () => {
  it('rejects internal hosts and private literals', () => {
    for (const url of [
      'http://127.0.0.1/a',
      'http://10.0.0.5/a',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/a',
      'http://localhost/a',
      'http://metadata.google.internal/a',
      'http://printer.local/a',
    ]) {
      expect(() => assertSafeFetchUrl(url)).toThrow(UnsafeFetchUrlError);
    }
  });

  it('rejects credentials and non-http schemes', () => {
    expect(() => assertSafeFetchUrl('https://user:pass@example.com/a')).toThrow();
    expect(() => assertSafeFetchUrl('file:///etc/passwd')).toThrow();
  });

  it('allows ordinary public publisher URLs', () => {
    expect(assertSafeFetchUrl('https://www.bbc.com/news/a').hostname).toBe('www.bbc.com');
    expect(assertSafeFetchUrl('http://example.test/feed').hostname).toBe('example.test');
  });
});
