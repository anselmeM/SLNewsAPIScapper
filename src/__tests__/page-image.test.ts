import { describe, expect, it } from 'vitest';
import { firstPageImage } from '../services/scraper.js';

describe('firstPageImage', () => {
  it('prefers og:image', () => {
    expect(firstPageImage('<meta property="og:image" content="https://cdn.test/a.jpg">')).toBe(
      'https://cdn.test/a.jpg',
    );
  });

  it('falls back to twitter:image on pages without og:image', () => {
    expect(firstPageImage('<meta name="twitter:image" content="https://cdn.test/b.jpg">')).toBe(
      'https://cdn.test/b.jpg',
    );
  });

  it('reads JSON-LD image when no meta tag exists', () => {
    const html = `<script type="application/ld+json">{"image":{"url":"https://cdn.test/c.jpg"}}</script>`;
    expect(firstPageImage(html)).toBe('https://cdn.test/c.jpg');
  });

  it('ignores chrome images', () => {
    expect(firstPageImage('<meta property="og:image" content="https://cdn.test/favicon.png">')).toBeNull();
  });
});
