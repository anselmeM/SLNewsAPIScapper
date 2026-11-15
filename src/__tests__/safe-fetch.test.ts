import dns from 'node:dns';
import { describe, expect, it, vi } from 'vitest';
import { createSafeLookup, fetchFollowingSafeRedirects } from '../utils/safe-fetch.js';
import { UnsafeFetchUrlError } from '../utils/safe-url.js';

function lookupHost(
  lookup: ReturnType<typeof createSafeLookup>,
  hostname: string,
  options: dns.LookupOptions = { family: 0 },
): Promise<{ address?: string; family?: number; error?: Error }> {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address, family) => {
      resolve({
        address: typeof address === 'string' ? address : undefined,
        family,
        error: error ?? undefined,
      });
    });
  });
}

function lookupHostAll(
  lookup: ReturnType<typeof createSafeLookup>,
  hostname: string,
): Promise<{ addresses?: dns.LookupAddress[]; error?: Error }> {
  return new Promise((resolve) => {
    lookup(hostname, { all: true, family: 0 }, (error, address) => {
      resolve({
        addresses: Array.isArray(address) ? address : undefined,
        error: error ?? undefined,
      });
    });
  });
}

function lookupAllAddresses(
  lookup: ReturnType<typeof createSafeLookup>,
  hostname: string,
  family: 4 | 6,
): Promise<dns.LookupAddress[] | undefined> {
  return new Promise((resolve) => {
    lookup(hostname, { all: true, family }, (_error, address) => {
      resolve(Array.isArray(address) ? address : undefined);
    });
  });
}

describe('safe DNS lookup', () => {
  it('pins a public hostname to the address it validated', async () => {
    const resolver = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
    ]) as unknown as typeof dns.promises.lookup;
    const lookup = createSafeLookup(resolver);

    const result = await lookupHost(lookup, 'publisher.test');

    expect(result.error).toBeUndefined();
    expect(result.address).toBe('93.184.216.34');
    expect(result.family).toBe(4);
    expect(resolver).toHaveBeenCalledWith('publisher.test', {
      all: true,
      verbatim: true,
    });
  });

  it('returns the validated address array when Node requests all answers', async () => {
    const resolver = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]) as unknown as typeof dns.promises.lookup;

    const result = await lookupHostAll(createSafeLookup(resolver), 'publisher.test');

    expect(result.error).toBeUndefined();
    expect(result.addresses).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
  });

  it('returns a single validated literal as an array when all answers are requested', async () => {
    const lookup = createSafeLookup(vi.fn() as unknown as typeof dns.promises.lookup);

    const result = await lookupHostAll(lookup, '93.184.216.34');

    expect(result.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('filters the returned answers to the requested address family', async () => {
    const resolver = vi.fn(async () => [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ]) as unknown as typeof dns.promises.lookup;
    const lookup = createSafeLookup(resolver);

    const v4 = await lookupHost(lookup, 'publisher.test', { family: 4 });
    const allV6 = await lookupAllAddresses(lookup, 'publisher.test', 6);

    expect(v4.address).toBe('93.184.216.34');
    expect(v4.family).toBe(4);
    expect(allV6).toEqual([{ address: '2606:4700:4700::1111', family: 6 }]);
  });

  it('fails when no answer matches the requested address family', async () => {
    const resolver = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
    ]) as unknown as typeof dns.promises.lookup;

    const result = await lookupHost(createSafeLookup(resolver), 'publisher.test', { family: 6 });

    expect(result.error).toMatchObject({ code: 'ENOTFOUND' });
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['private IPv4', '10.20.30.40'],
    ['link-local metadata', '169.254.169.254'],
    ['private IPv6', 'fd00::1'],
    ['site-local IPv6', 'fec0::1'],
  ])('rejects a %s DNS answer', async (_label, address) => {
    const resolver = vi.fn(async () => [
      { address, family: address.includes(':') ? 6 : 4 },
    ]) as unknown as typeof dns.promises.lookup;
    const result = await lookupHost(createSafeLookup(resolver), 'rebind.test');

    expect(result.error).toBeInstanceOf(UnsafeFetchUrlError);
    expect(result.address).toBeUndefined();
  });

  it('rejects a mixed public/private answer instead of picking one', async () => {
    const resolver = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ]) as unknown as typeof dns.promises.lookup;

    const result = await lookupHost(createSafeLookup(resolver), 'rebind.test');

    expect(result.error).toBeInstanceOf(UnsafeFetchUrlError);
  });

  it.each(['::ffff:7f00:1', '0:0:0:0:0:ffff:127.0.0.1'])(
    'rejects a private IPv4-mapped DNS answer (%s)',
    async (address) => {
      const resolver = vi.fn(async () => [{ address, family: 6 }]) as unknown as typeof dns.promises.lookup;

      const result = await lookupHost(createSafeLookup(resolver), 'rebind.test');

      expect(result.error).toBeInstanceOf(UnsafeFetchUrlError);
    },
  );

  it('rejects private IP literals without asking DNS', async () => {
    const resolver = vi.fn() as unknown as typeof dns.promises.lookup;
    const result = await lookupHost(createSafeLookup(resolver), '127.0.0.1');

    expect(result.error).toBeInstanceOf(UnsafeFetchUrlError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('accepts a public IP literal', async () => {
    const resolver = vi.fn() as unknown as typeof dns.promises.lookup;
    const result = await lookupHost(createSafeLookup(resolver), '93.184.216.34');

    expect(result.error).toBeUndefined();
    expect(result.address).toBe('93.184.216.34');
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe('safe redirect following', () => {
  const response = (status: number, location?: string): { status: number; headers: unknown } => ({
    status,
    headers: location ? { location } : {},
  });

  it('follows a relative redirect and returns the final response', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(302, '/next'))
      .mockResolvedValueOnce({ status: 200, headers: {} });

    const final = await fetchFollowingSafeRedirects('https://publisher.test/a', request);

    expect(final.status).toBe(200);
    expect(request).toHaveBeenNthCalledWith(2, 'https://publisher.test/next');
  });

  it('rejects a redirect to a private IP literal before requesting it', async () => {
    const request = vi.fn().mockResolvedValueOnce(response(301, 'http://169.254.169.254/latest/meta-data'));

    await expect(fetchFollowingSafeRedirects('https://publisher.test/a', request)).rejects.toBeInstanceOf(
      UnsafeFetchUrlError,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects a redirect to a non-HTTP scheme', async () => {
    const request = vi.fn().mockResolvedValueOnce(response(302, 'file:///etc/passwd'));

    await expect(fetchFollowingSafeRedirects('https://publisher.test/a', request)).rejects.toBeInstanceOf(
      UnsafeFetchUrlError,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects after the redirect budget is exhausted', async () => {
    const request = vi.fn().mockResolvedValue(response(302, '/loop'));

    await expect(fetchFollowingSafeRedirects('https://publisher.test/a', request, 2)).rejects.toThrow(
      'too many redirects',
    );
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('returns a redirect without a Location header as-is', async () => {
    const request = vi.fn().mockResolvedValueOnce(response(302));

    const result = await fetchFollowingSafeRedirects('https://publisher.test/a', request);

    expect(result.status).toBe(302);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
