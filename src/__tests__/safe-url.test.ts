import { describe, expect, it } from 'vitest';
import { assertSafeFetchUrl, isPrivateAddress, UnsafeFetchUrlError } from '../utils/safe-url.js';

describe('scraper fetch URL guard', () => {
  it('rejects internal hosts and private literals', () => {
    for (const url of [
      'http://127.0.0.1/a',
      'http://10.0.0.5/a',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/a',
      'http://[::ffff:127.0.0.1]/a',
      'http://[::ffff:7f00:1]/a',
      'http://[0:0:0:0:0:ffff:127.0.0.1]/a',
      'http://[0:0:0:0:0:ffff:7f00:1]/a',
      'http://[0:0:0:0:0:0:0:1]/a',
      'http://localhost/a',
      'http://metadata.google.internal/a',
      'http://printer.local/a',
    ]) {
      expect(() => assertSafeFetchUrl(url)).toThrow(UnsafeFetchUrlError);
    }
  });

  it('rejects credentials and non-http schemes', () => {
    expect(() => assertSafeFetchUrl('https://user:pass@example.com/a')).toThrow();
    expect(() => assertSafeFetchUrl('file:///etc/passwd')).toThrow();
  });

  it('allows ordinary public publisher URLs', () => {
    expect(assertSafeFetchUrl('https://www.bbc.com/news/a').hostname).toBe('www.bbc.com');
    expect(assertSafeFetchUrl('http://example.test/feed').hostname).toBe('example.test');
  });
});

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '169.254.169.254',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.5',
    '::ffff:a00:5',
    '::ffff:172.16.0.1',
    '::ffff:ac10:1',
    '::ffff:192.168.0.1',
    '::ffff:c0a8:1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '::ffff:0:127.0.0.1',
    '0:0:0:0:0:ffff:127.0.0.1',
    '0:0:0:0:0:ffff:7f00:1',
    '0:0:0:0:0:0:0:1',
    '0:0:0:0:0:0:0:0',
    '::127.0.0.1',
    'fe80::1',
    'fc00::1',
    'fd00::1',
    'ff02::1',
    '2002:7f00:1::',
    '64:ff9b::7f00:1',
  ])('treats %s as private', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '93.184.216.34',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '0:0:0:0:0:ffff:8.8.8.8',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '2002:808:808::',
    '64:ff9b::808:808',
    '::8.8.8.8',
  ])('treats %s as public', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it('fails closed for input that is not an IP address', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});
