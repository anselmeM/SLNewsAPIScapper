import { describe, expect, it } from 'vitest';
import { imageBackfillLimits } from '../services/image-metrics.js';

describe('image backfill budgets', () => {
  it('uses base budgets while the backlog exists', () => {
    expect(imageBackfillLimits(120, {})).toEqual({
      missing: 15,
      revalidate: 25,
      reason: 'base',
    });
  });

  it('raises budgets once the missing backlog is clear', () => {
    expect(imageBackfillLimits(0, {})).toEqual({
      missing: 30,
      revalidate: 50,
      reason: 'backlog-clear',
    });
  });

  it('lets env override either budget', () => {
    expect(imageBackfillLimits(0, { IMAGE_BACKFILL_MISSING_LIMIT: '40' })).toEqual({
      missing: 40,
      revalidate: 25,
      reason: 'env',
    });
  });
});
