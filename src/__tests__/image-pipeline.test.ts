import { describe, expect, it, vi } from 'vitest';
import {
  fingerprintFromHeaders,
  imageDimensions,
  looksLikeChromeImage,
  probeAndFingerprint,
  withImageFingerprint,
} from '../services/image-pipeline.js';

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  buffer.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpeg(width: number, height: number): Buffer {
  const buffer = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

describe('image pipeline', () => {
  it('reads PNG and JPEG dimensions', () => {
    expect(imageDimensions(png(1200, 800))).toEqual({ width: 1200, height: 800 });
    expect(imageDimensions(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('rejects chrome filenames', () => {
    expect(looksLikeChromeImage('https://cdn.test/images/favicon.png')).toBe(true);
    expect(looksLikeChromeImage('https://cdn.test/uploads/logo.jpg')).toBe(true);
    expect(looksLikeChromeImage('https://cdn.test/news/leone-stars.jpg')).toBe(false);
  });

  it('appends a stable fingerprint query param', () => {
    const fingerprint = fingerprintFromHeaders({ etag: '"abc"', 'content-length': '1234' });
    expect(fingerprint).toHaveLength(12);
    expect(withImageFingerprint('https://cdn.test/a.jpg?x=1', fingerprint)).toContain('v=');
    expect(withImageFingerprint('https://cdn.test/a.jpg', fingerprint)).toBe(
      withImageFingerprint('https://cdn.test/a.jpg', fingerprint),
    );
  });

  it('distinguishes changed ETags', () => {
    const first = fingerprintFromHeaders({ etag: '"v1"' });
    const second = fingerprintFromHeaders({ etag: '"v2"' });
    expect(first).not.toBe(second);
  });

  it('disables ambient proxies for image fetches so the DNS pin cannot be bypassed', async () => {
    const fetcher = vi.fn().mockResolvedValue({ data: png(1200, 800), headers: {} });

    const probe = await probeAndFingerprint('https://cdn.test/story.png', { fetch: fetcher as never });

    expect(probe.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('https://cdn.test/story.png', expect.objectContaining({ proxy: false }));
  });

  it('follows a safe image redirect through the validated helper', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: 'https://cdn2.test/story.png' },
        data: Buffer.alloc(0),
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: png(1200, 800) });

    const probe = await probeAndFingerprint('https://cdn.test/story.png', { fetch: fetcher as never });

    expect(probe.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://cdn2.test/story.png',
      expect.objectContaining({ maxRedirects: 0 }),
    );
  });

  it('never follows an image redirect to a private address', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 302,
      headers: { location: 'http://127.0.0.1/secret.png' },
      data: Buffer.alloc(0),
    });

    const probe = await probeAndFingerprint('https://cdn.test/story.png', { fetch: fetcher as never });

    expect(probe).toMatchObject({ ok: true, reason: 'fetch-failed' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
