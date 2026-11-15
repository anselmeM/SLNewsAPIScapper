import { describe, expect, it, vi } from 'vitest';
import {
  fingerprintFromHeaders,
  imageDimensions,
  looksLikeChromeImage,
  probeAndFingerprint,
  withImageFingerprint,
} from '../services/image-pipeline.js';
import { assertSafeFetchUrl, UnsafeFetchUrlError } from '../utils/safe-url.js';

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  buffer.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('image pipeline edge cases', () => {
  it('reads GIF and WebP dimensions, and rejects unknown data', () => {
    const gif = Buffer.alloc(13);
    gif.write('GIF89a', 0, 'ascii');
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(240, 8);
    expect(imageDimensions(gif)).toEqual({ width: 320, height: 240 });

    const vp8x = Buffer.alloc(31);
    vp8x.write('RIFF', 0, 'ascii');
    vp8x.write('WEBP', 8, 'ascii');
    vp8x.write('VP8X', 12, 'ascii');
    vp8x.writeUIntLE(799, 24, 3);
    vp8x.writeUIntLE(599, 27, 3);
    expect(imageDimensions(vp8x)).toEqual({ width: 800, height: 600 });
    expect(imageDimensions(Buffer.from('not an image'))).toBeNull();
  });

  it('derives fingerprints and handles missing/invalid URLs', () => {
    expect(fingerprintFromHeaders({})).toBeNull();
    expect(
      fingerprintFromHeaders({
        'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
        'content-length': '99',
      }),
    ).toHaveLength(12);
    expect(withImageFingerprint('https://cdn.test/a.jpg', null)).toBe('https://cdn.test/a.jpg');
    expect(withImageFingerprint('not a url', 'abc')).toBe('not a url');
    expect(looksLikeChromeImage('images/spacer.gif')).toBe(true);
    expect(looksLikeChromeImage('https://cdn.test/news/story.jpg')).toBe(false);
  });

  it('probes dimensions, rejects tiny images and tolerates fetch errors', async () => {
    const fetcher = vi.fn();
    const tooSmall = await probeAndFingerprint('https://cdn.test/small.jpg', {
      fetch: fetcher.mockResolvedValue({
        data: png(100, 100),
        headers: {},
      }) as never,
    });
    expect(tooSmall).toMatchObject({ ok: false, reason: 'too-small' });

    const unreadable = await probeAndFingerprint('https://cdn.test/bad.jpg', {
      fetch: fetcher.mockResolvedValue({
        data: Buffer.from('nope'),
        headers: {},
      }) as never,
    });
    expect(unreadable).toMatchObject({ ok: true, reason: 'unreadable' });

    const failed = await probeAndFingerprint('https://cdn.test/down.jpg', {
      fetch: fetcher.mockRejectedValue(new Error('down')) as never,
    });
    expect(failed).toMatchObject({ ok: true, reason: 'fetch-failed' });

    const good = await probeAndFingerprint('https://cdn.test/good.jpg', {
      fetch: fetcher.mockResolvedValue({
        data: png(1200, 800),
        headers: { etag: '"v1"' },
      }) as never,
    });
    expect(good.ok).toBe(true);
    expect(good.url).toContain('v=');

    const chrome = await probeAndFingerprint('https://cdn.test/favicon.ico', {
      fetch: fetcher.mockRejectedValue(new Error('must not fetch')) as never,
    });
    expect(chrome).toMatchObject({ ok: false, reason: 'chrome' });
  });
});

it('rejects an internal image URL before calling the fetcher', async () => {
  const fetcher = vi.fn();
  const result = await probeAndFingerprint('http://169.254.169.254/latest/meta-data.jpg', {
    fetch: fetcher as never,
  });

  expect(result).toMatchObject({ ok: false, reason: 'unsafe' });
  expect(fetcher).not.toHaveBeenCalled();
});

describe('safe URL edge cases', () => {
  it('rejects credentials and internal hostnames', () => {
    expect(() => assertSafeFetchUrl('https://user:pass@example.com/a')).toThrow(UnsafeFetchUrlError);
    expect(() => assertSafeFetchUrl('http://printer.local/a')).toThrow(UnsafeFetchUrlError);
    expect(() => assertSafeFetchUrl('http://service.internal/a')).toThrow(UnsafeFetchUrlError);
    expect(() => assertSafeFetchUrl('http://metadata.google.internal/a')).toThrow(UnsafeFetchUrlError);
  });

  it('allows a public IPv6 literal', () => {
    expect(assertSafeFetchUrl('https://[2001:4860:4860::8888]/a').hostname).toBe('[2001:4860:4860::8888]');
  });
});
