import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({
  prisma: {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  },
}));

describe('runtime state', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('creates the table once and upserts snapshots', async () => {
    const { prisma } = await import('../db.js');
    const { putRuntimeState } = await import('../services/runtime-state.js');
    await putRuntimeState('image_backfill', { filled: 1 });
    await putRuntimeState('image_backfill', { filled: 2 });
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(3);
    expect(prisma.$executeRawUnsafe.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS runtime_state');
    expect(prisma.$executeRawUnsafe.mock.calls[2].slice(1)).toEqual(['image_backfill', '{"filled":2}']);
  });

  it('reads a snapshot and tolerates database errors', async () => {
    const { prisma } = await import('../db.js');
    const { getRuntimeState } = await import('../services/runtime-state.js');
    prisma.$queryRawUnsafe.mockResolvedValue([{ value: { filled: 3 } }]);
    await expect(getRuntimeState('image_backfill')).resolves.toEqual({ filled: 3 });

    prisma.$queryRawUnsafe.mockRejectedValue(new Error('down'));
    await expect(getRuntimeState('image_backfill')).resolves.toBeNull();
  });
});
