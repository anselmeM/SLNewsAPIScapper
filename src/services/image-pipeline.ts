import axios from 'axios';
import { createHash } from 'node:crypto';
import { assertSafeFetchUrl } from '../utils/safe-url.js';
import {
  fetchFollowingSafeRedirects,
  isOkOrRedirectStatus,
  safeHttpAgent,
  safeHttpsAgent,
} from '../utils/safe-fetch.js';

/** Minimum acceptable story image; below this it is a logo or spacer. */
export const MIN_IMAGE_WIDTH = 300;
export const MIN_IMAGE_HEIGHT = 200;

const CHROME_PATTERN =
  /(favicon|sprite|placeholder|avatar|logo|icon|default[-_]|blank\.gif|pixel\.gif|spacer|1x1)([._-]|$)/i;

/** Free check: URLs that are clearly chrome, not story photography. */
export function looksLikeChromeImage(url: string): boolean {
  try {
    return CHROME_PATTERN.test(new URL(url).pathname);
  } catch {
    return CHROME_PATTERN.test(url);
  }
}

/** Stable short fingerprint from HTTP validators, or null when absent. */
export function fingerprintFromHeaders(headers: Record<string, unknown>): string | null {
  const etag = String(headers.etag ?? '').trim();
  const lastModified = String(headers['last-modified'] ?? '').trim();
  const length = String(headers['content-length'] ?? '').trim();
  // `:` alone is not a validator; without any header return null so the URL is
  // left untouched rather than receiving the same bogus fingerprint for every
  // image.
  const material = etag || (lastModified || length ? `${lastModified}:${length}` : '');
  if (!material) return null;
  return createHash('sha1').update(material).digest('hex').slice(0, 12);
}

/** Appends `v=<fingerprint>` so an overwritten image busts client/CDN caches. */
export function withImageFingerprint(url: string, fingerprint: string | null): string {
  if (!fingerprint) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('v', fingerprint);
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Dimensions of PNG, JPEG, GIF or WebP buffers; null when unrecognised. */
export function imageDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length > 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 10 && buffer.toString('ascii', 0, 3) === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length > 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buffer.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
    if (kind === 'VP8 ') {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + length;
    }
  }
  return null;
}

export interface ImageProbe {
  url: string;
  width: number | null;
  height: number | null;
  ok: boolean;
  reason?: 'chrome' | 'too-small' | 'fetch-failed' | 'unreadable' | 'unsafe';
}

/**
 * Validates an image and returns a cache-busting URL.
 *
 * A failed fetch is not a rejection: the URL is kept unchanged so a temporary
 * CDN error cannot remove every picture from the feed.
 */
export async function probeAndFingerprint(
  url: string,
  options: { fetch?: typeof axios.get; minWidth?: number; minHeight?: number } = {},
): Promise<ImageProbe> {
  try {
    assertSafeFetchUrl(url);
  } catch {
    return { url, width: null, height: null, ok: false, reason: 'unsafe' };
  }
  if (looksLikeChromeImage(url)) {
    return { url, width: null, height: null, ok: false, reason: 'chrome' };
  }
  const fetcher = options.fetch ?? axios.get;
  try {
    const response = await fetchFollowingSafeRedirects(url, (target) =>
      fetcher(target, {
        responseType: 'arraybuffer',
        timeout: 8000,
        maxContentLength: 4 * 1024 * 1024,
        httpAgent: safeHttpAgent,
        httpsAgent: safeHttpsAgent,
        // Ignore ambient proxy env vars: a proxy resolves the image host itself,
        // which would bypass the validated DNS lookup the agents pin (SSRF).
        proxy: false,
        // Follow redirects through the validated helper instead of axios, so a
        // Location pointing at a private address can never be dialled.
        maxRedirects: 0,
        validateStatus: isOkOrRedirectStatus,
        headers: {
          'user-agent':
            'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36',
          referer: `${new URL(url).origin}/`,
        },
      }),
    );
    const dimensions = imageDimensions(Buffer.from(response.data));
    if (!dimensions) {
      return { url, width: null, height: null, ok: true, reason: 'unreadable' };
    }
    const tooSmall =
      dimensions.width < (options.minWidth ?? MIN_IMAGE_WIDTH) ||
      dimensions.height < (options.minHeight ?? MIN_IMAGE_HEIGHT);
    if (tooSmall) {
      return { ...dimensions, url, ok: false, reason: 'too-small' };
    }
    const fingerprint = fingerprintFromHeaders(response.headers as Record<string, unknown>);
    return {
      ...dimensions,
      url: withImageFingerprint(url, fingerprint),
      ok: true,
    };
  } catch {
    return { url, width: null, height: null, ok: true, reason: 'fetch-failed' };
  }
}
