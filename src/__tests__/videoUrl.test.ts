import { describe, expect, it } from 'vitest';
import { toWatchUrl } from '../utils/videoUrl.js';

const ID = '3f4Y2N4w1bY';
const WATCH = `https://www.youtube.com/watch?v=${ID}`;

describe('toWatchUrl', () => {
  it('keeps a real watch URL', () => {
    expect(toWatchUrl(WATCH, ID)).toBe(WATCH);
  });

  it('keeps shorts and youtu.be URLs', () => {
    expect(toWatchUrl(`https://www.youtube.com/shorts/${ID}`, ID)).toBe(`https://www.youtube.com/shorts/${ID}`);
    expect(toWatchUrl(`https://youtu.be/${ID}`, ID)).toBe(`https://youtu.be/${ID}`);
  });

  it('rebuilds channel or stripped URLs from the video id', () => {
    expect(toWatchUrl('https://www.youtube.com/@AYVMedia', ID)).toBe(WATCH);
    expect(toWatchUrl('https://www.youtube.com/watch', ID)).toBe(WATCH);
    expect(toWatchUrl('https://www.youtube.com/channel/UCabc', ID)).toBe(WATCH);
  });

  it('leaves non-YouTube URLs and bad ids alone', () => {
    expect(toWatchUrl('https://example.com/x', ID)).toBe('https://example.com/x');
    expect(toWatchUrl(WATCH, 'not-an-id')).toBe(WATCH);
  });
});
