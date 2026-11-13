import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

vi.mock('../db.js', () => ({
  prisma: {
    article: {
      count: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));
vi.mock('../services/runtime-state.js', () => ({
  getRuntimeState: vi.fn().mockResolvedValue(null),
  putRuntimeState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/image-pipeline.js', () => ({
  looksLikeChromeImage: vi.fn(() => false),
  probeAndFingerprint: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

const { prisma } = await import('../db.js');
const { probeAndFingerprint } = await import('../services/image-pipeline.js');
const { getRuntimeState } = await import('../services/runtime-state.js');
const logger = (await import('../logger.js')).default;
const { backfillImages } = await import('../services/scraper.js');

const mocks = {
  count: prisma.article.count as ReturnType<typeof vi.fn>,
  findMany: prisma.article.findMany as ReturnType<typeof vi.fn>,
  update: prisma.article.update as ReturnType<typeof vi.fn>,
  probe: probeAndFingerprint as ReturnType<typeof vi.fn>,
  previous: getRuntimeState as ReturnType<typeof vi.fn>,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.count.mockResolvedValue(0);
  mocks.findMany.mockResolvedValue([]);
  mocks.update.mockResolvedValue({ id: 1 });
  mocks.probe.mockResolvedValue({ ok: true, url: 'https://cdn.test/image.jpg?v=abc' });
  mocks.previous.mockResolvedValue(null);
  (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
    data: '<html><head><meta property="og:image" content="https://publisher.test/a.jpg"></head><body></body></html>',
  });
});

describe('backfillImages', () => {
  it('fills a missing image from the article page', async () => {
    mocks.count.mockResolvedValue(1);
    mocks.findMany.mockImplementation((args: { where: { imageUrl?: unknown } }) => {
      if (args.where.imageUrl === null) return Promise.resolve([{ id: 1, link: 'https://publisher.test/a' }]);
      return Promise.resolve([]);
    });
    mocks.probe.mockResolvedValue({ ok: true, url: 'https://cdn.test/a.jpg?v=1' });

    await backfillImages(Date.now() + 60_000);

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { imageUrl: 'https://cdn.test/a.jpg?v=1' },
    });
  });

  it('revalidates an unfingerprinted image', async () => {
    mocks.count.mockResolvedValue(0);
    mocks.findMany.mockImplementation((args: { where: { imageUrl?: unknown } }) => {
      if (args.where.imageUrl && typeof args.where.imageUrl === 'object') {
        return Promise.resolve([{ id: 2, imageUrl: 'https://cdn.test/b.jpg' }]);
      }
      return Promise.resolve([]);
    });
    mocks.probe.mockResolvedValue({ ok: true, url: 'https://cdn.test/b.jpg?v=2' });

    await backfillImages(Date.now() + 60_000);

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { imageUrl: 'https://cdn.test/b.jpg?v=2' },
    });
  });

  it('does no work when the deadline has passed', async () => {
    await backfillImages(Date.now() - 1);
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it('logs when the missing backlog is stuck above the threshold', async () => {
    mocks.count.mockResolvedValue(100);
    mocks.previous.mockResolvedValue({ missing_remaining: 100, stuck_runs: 1 });
    mocks.findMany.mockResolvedValue([]);

    await backfillImages(Date.now() + 60_000);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ missingRemaining: 100 }),
      'Image backfill backlog is stuck',
    );
  });
});
