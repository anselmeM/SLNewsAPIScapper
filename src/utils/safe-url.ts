import net from 'node:net';

/** Thrown when a URL must not be fetched by the scraper. */
export class UnsafeFetchUrlError extends Error {}

function isPrivateIpv4(address: string): boolean {
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

function ipv4FromBytes(bytes: number[]): string {
  return bytes.join('.');
}

/**
 * Parses an IPv6 address into its 16 bytes, expanding `::` and normalizing the
 * dotted IPv4 tail (`::ffff:127.0.0.1`) to hex groups. Returns null for input
 * that `net.isIPv6` accepted but this parser cannot represent.
 */
export function parseIpv6(address: string): number[] | null {
  let value = address.trim().toLowerCase();
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);

  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    if (lastColon === -1) return null;
    const ipv4 = value.slice(lastColon + 1);
    if (!net.isIPv4(ipv4)) return null;
    const hex = ipv4
      .split('.')
      .map((octet) => Number(octet).toString(16).padStart(2, '0'))
      .join('');
    value = `${value.slice(0, lastColon + 1)}${hex.slice(0, 4)}:${hex.slice(4)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;

  const groups: string[] = [];
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const zeros = 8 - left.length - right.length;
    if (zeros < 0) return null;
    groups.push(...left, ...Array.from({ length: zeros }, () => '0'), ...right);
  } else {
    groups.push(...value.split(':'));
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const groupValue = Number.parseInt(group, 16);
    bytes.push((groupValue >> 8) & 0xff, groupValue & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

function isPrivateIpv6(bytes: number[]): boolean {
  const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = bytes;

  // IPv4-mapped ::ffff:a.b.c.d/96, including the hex form ::ffff:7f00:1 and
  // expanded variants such as 0:0:0:0:0:ffff:127.0.0.1.
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4(ipv4FromBytes(bytes.slice(12)));
  }

  // IPv4-translated ::ffff:0:a.b.c.d/96.
  if (
    bytes.slice(0, 8).every((byte) => byte === 0) &&
    bytes[8] === 0xff &&
    bytes[9] === 0xff &&
    bytes[10] === 0 &&
    bytes[11] === 0
  ) {
    return isPrivateIpv4(ipv4FromBytes(bytes.slice(12)));
  }

  // IPv4-compatible ::a.b.c.d/96 (deprecated, includes :: and ::1).
  if (bytes.slice(0, 12).every((byte) => byte === 0)) {
    return isPrivateIpv4(ipv4FromBytes(bytes.slice(12)));
  }

  // Unique local fc00::/7.
  if ((b0 & 0xfe) === 0xfc) return true;
  // Link-local fe80::/10.
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true;
  // Multicast ff00::/8.
  if (b0 === 0xff) return true;
  // 6to4 2002::/16 embeds the IPv4 destination in bytes 2-5.
  if (b0 === 0x20 && b1 === 0x02) {
    return isPrivateIpv4(ipv4FromBytes(bytes.slice(2, 6)));
  }
  // NAT64 64:ff9b::/96 embeds the IPv4 destination in the last four bytes.
  if (b0 === 0 && b1 === 0x64 && b2 === 0xff && b3 === 0x9b && bytes.slice(4, 12).every((byte) => byte === 0)) {
    return isPrivateIpv4(ipv4FromBytes(bytes.slice(12)));
  }

  return false;
}

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) return isPrivateIpv4(address);
  if (net.isIPv6(address)) {
    const bytes = parseIpv6(address);
    // IPv6 that cannot be normalised is treated as unsafe, matching the old
    // fail-closed behaviour for unrecognised input.
    return bytes ? isPrivateIpv6(bytes) : true;
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
 * IPv6 literals are parsed and classified by their bytes, so IPv4-mapped and
 * IPv4-compatible forms are checked in expanded or hexadecimal notation too.
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
