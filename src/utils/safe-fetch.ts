import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { UnsafeFetchUrlError, isPrivateAddress } from './safe-url.js';

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
