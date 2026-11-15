import dns from 'node:dns';
import { describe, expect, it, vi } from 'vitest';
import { createSafeLookup } from '../utils/safe-fetch.js';
import { UnsafeFetchUrlError } from '../utils/safe-url.js';

function lookupHost(
  lookup: ReturnType<typeof createSafeLookup>,
  hostname: string,
): Promise<{ address?: string; family?: number; error?: Error }> {
  return new Promise((resolve) => {
    lookup(hostname, { family: 0 }, (error, address, family) => {
      resolve({ address, family, error: error ?? undefined });
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

  it.each([
    ['loopback', '127.0.0.1'],
    ['private IPv4', '10.20.30.40'],
    ['link-local metadata', '169.254.169.254'],
    ['private IPv6', 'fd00::1'],
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
