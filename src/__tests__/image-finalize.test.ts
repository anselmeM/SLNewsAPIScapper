import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ probe: vi.fn() }));

vi.mock('../services/image-pipeline.js', () => ({
  looksLikeChromeImage: vi.fn((url: string) => /favicon|logo|sprite/i.test(url)),
  probeAndFingerprint: mocks.probe,
}));

import { finalizeImageUrl } from '../services/ingestion/content.js';

describe('finalizeImageUrl', () => {
  beforeEach(() => {
    mocks.probe.mockReset();
  });

  it('drops an unsafe probe instead of storing its URL', async () => {
    mocks.probe.mockResolvedValue({
      url: 'http://169.254.169.254/latest/meta-data.jpg',
      width: null,
      height: null,
      ok: false,
      reason: 'unsafe',
    });

    await expect(finalizeImageUrl('http://169.254.169.254/latest/meta-data.jpg')).resolves.toBeNull();
  });

  it('drops too-small images and chrome candidates', async () => {
    mocks.probe.mockResolvedValue({
      url: 'https://cdn.test/small.jpg',
      width: 10,
      height: 10,
      ok: false,
      reason: 'too-small',
    });

    await expect(finalizeImageUrl('https://cdn.test/small.jpg')).resolves.toBeNull();
    await expect(finalizeImageUrl('https://cdn.test/favicon.png')).resolves.toBeNull();
    expect(mocks.probe).toHaveBeenCalledTimes(1);
  });

  it('keeps a transiently unreachable image URL', async () => {
    mocks.probe.mockResolvedValue({
      url: 'https://cdn.test/down.jpg',
      width: null,
      height: null,
      ok: true,
      reason: 'fetch-failed',
    });

    await expect(finalizeImageUrl('https://cdn.test/down.jpg')).resolves.toBe('https://cdn.test/down.jpg');
  });

  it('returns the fingerprinted URL for a good image', async () => {
    mocks.probe.mockResolvedValue({
      url: 'https://cdn.test/good.jpg?v=abc',
      width: 1200,
      height: 800,
      ok: true,
    });

    await expect(finalizeImageUrl('https://cdn.test/good.jpg')).resolves.toBe('https://cdn.test/good.jpg?v=abc');
  });
});
