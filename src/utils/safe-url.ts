import net from 'node:net';

/** Thrown when a URL must not be fetched by the scraper. */
export class UnsafeFetchUrlError extends Error {}

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    return (
      value === '::1' ||
      value === '::' ||
      value.startsWith('fe8') ||
      value.startsWith('fe9') ||
      value.startsWith('fea') ||
      value.startsWith('feb') ||
      value.startsWith('fc') ||
      value.startsWith('fd') ||
      (value.startsWith('::ffff:') && isPrivateAddress(value.slice(7)))
    );
  }
  return true;
}

/**
 * Synchronous guard for scraper outbound requests.
 *
 * Feed content controls article links and image URLs, so a compromised or
 * over-permissive feed must not be able to point the worker at Render-internal
 * addresses. DNS answers are not resolved here (async, and tests use .test
 * hosts); literal/private hostnames and credentials are rejected outright.
 */
export function assertSafeFetchUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeFetchUrlError('invalid url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeFetchUrlError('scheme');
  }
  if (url.username || url.password) throw new UnsafeFetchUrlError('credentials');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    throw new UnsafeFetchUrlError('host');
  }
  if (net.isIP(host) && isPrivateAddress(host)) throw new UnsafeFetchUrlError('address');
  return url;
}
