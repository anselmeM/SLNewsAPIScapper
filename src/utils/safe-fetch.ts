import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { UnsafeFetchUrlError, assertSafeFetchUrl, isPrivateAddress } from './safe-url.js';

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string, family?: number) => void;

/**
 * DNS lookup bound to an HTTP(S) agent.
 *
 * Resolving and validating in the same lookup callback is what makes this a
 * pin: the address checked here is the address the socket connects to, so a
 * DNS server cannot answer with a public IP for the check and a private one
 * for the connection. Feed-controlled image/article URLs must never reach
 * Render-internal addresses or cloud metadata endpoints.
 */
export function createSafeLookup(
  resolver: typeof dns.promises.lookup = dns.promises.lookup,
): (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => void {
  return (hostname: string, _options: dns.LookupOptions, callback: LookupCallback): void => {
    const literal = net.isIP(hostname);
    if (literal) {
      if (isPrivateAddress(hostname)) {
        callback(new UnsafeFetchUrlError('address'));
        return;
      }
      callback(null, hostname, literal);
      return;
    }

    void resolver(hostname, { all: true, verbatim: true }).then(
      (addresses: dns.LookupAddress[]) => {
        if (addresses.length === 0) {
          callback(new UnsafeFetchUrlError('address'));
          return;
        }
        if (addresses.some((entry) => isPrivateAddress(entry.address))) {
          callback(new UnsafeFetchUrlError('address'));
          return;
        }
        const first = addresses[0];
        if (!first) {
          callback(new UnsafeFetchUrlError('address'));
          return;
        }
        callback(null, first.address, first.family);
      },
      (error: unknown) => {
        callback(error instanceof Error ? (error as NodeJS.ErrnoException) : new UnsafeFetchUrlError('address'));
      },
    );
  };
}

/** The production lookup; tests inject `createSafeLookup(fakeResolver)`. */
export const safeLookup = createSafeLookup();

/**
 * Agents shared by every scraper GET. They are deliberately module-level so a
 * connection (and therefore a pinned IP) can be reused across retries.
 */
export const safeHttpAgent = new http.Agent({
  lookup: safeLookup as unknown as http.AgentOptions['lookup'],
});
export const safeHttpsAgent = new https.Agent({
  lookup: safeLookup as unknown as https.AgentOptions['lookup'],
});

/** Statuses that make the client follow a `Location` header. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

/** Axios `validateStatus` that lets a redirect response through for manual handling. */
export function isOkOrRedirectStatus(status: number): boolean {
  return (status >= 200 && status < 300) || isRedirectStatus(status);
}

interface RedirectResponse {
  status: number;
  headers?: unknown;
}

/**
 * Follows HTTP redirects one hop at a time, validating every target against the
 * same URL guard as the initial request before making the next request.
 *
 * Automatic redirect handling must be disabled (`maxRedirects: 0`) so a
 * redirect cannot bypass the guard: `assertSafeFetchUrl` only sees the URL the
 * scraper was given, while a `Location` is chosen by the remote server. A
 * redirect straight to a private IP literal would otherwise be dialled by Node
 * without a DNS lookup, skipping the pinned agents' validation entirely.
 */
export async function fetchFollowingSafeRedirects<T extends RedirectResponse>(
  initialUrl: string,
  request: (url: string) => Promise<T>,
  maxRedirects = 5,
): Promise<T> {
  // Validate the initial URL without re-serializing it: callers expect the
  // exact URL string they supplied (and URL#toString can add a trailing slash).
  let requestUrl = initialUrl.trim();
  let base = assertSafeFetchUrl(requestUrl);

  for (let followed = 0; ; followed += 1) {
    const response = await request(requestUrl);
    if (!isRedirectStatus(response.status)) return response;

    const headers = (response.headers ?? {}) as Record<string, unknown>;
    const location = headers.location ?? headers.Location;
    if (!location) return response;

    if (followed >= maxRedirects) throw new UnsafeFetchUrlError('too many redirects');
    base = assertSafeFetchUrl(new URL(String(location), base).toString());
    requestUrl = base.toString();
  }
}
