import { describe, expect, it } from 'vitest';
import { evaluateImageBackfillAlert, imageBackfillLimits } from '../services/image-metrics.js';

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

  it('alerts only after repeated runs with no progress', () => {
    const previous = {
      filled: 0,
      revalidated: 0,
      missing_remaining: 120,
      limits: { missing: 15, revalidate: 25, reason: 'base' as const },
      last_run_at: 1,
      last_duration_ms: 1,
      stuck_runs: 0,
      alert: false,
      alert_reason: null,
    };
    const first = evaluateImageBackfillAlert({ missingRemaining: 120, previous, threshold: 50 });
    expect(first.stuck_runs).toBe(1);
    expect(first.alert).toBe(false);

    const second = evaluateImageBackfillAlert({
      missingRemaining: 120,
      previous: { ...previous, stuck_runs: 1 },
      threshold: 50,
    });
    expect(second.alert).toBe(true);
    expect(second.alert_reason).toContain('preview-image extraction');
  });

  it('resets the counter when the backlog falls', () => {
    const previous = {
      filled: 10,
      revalidated: 0,
      missing_remaining: 120,
      limits: { missing: 15, revalidate: 25, reason: 'base' as const },
      last_run_at: 1,
      last_duration_ms: 1,
      stuck_runs: 2,
      alert: true,
      alert_reason: 'x',
    };
    const result = evaluateImageBackfillAlert({ missingRemaining: 90, previous, threshold: 50 });
    expect(result.stuck_runs).toBe(0);
    expect(result.alert).toBe(false);
  });

  it('lets env override either budget', () => {
    expect(imageBackfillLimits(0, { IMAGE_BACKFILL_MISSING_LIMIT: '40' })).toEqual({
      missing: 40,
      revalidate: 25,
      reason: 'env',
    });
  });
});
