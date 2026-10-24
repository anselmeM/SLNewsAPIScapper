import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetSourceHealth,
  recordSourceFailure,
  recordSourceSuccess,
  shouldSkipSource,
  sourceHealthSnapshot,
} from '../services/source-health.js';

describe('source health backoff', () => {
  beforeEach(() => __resetSourceHealth());

  it('backs off after failures and clears on success', () => {
    const t0 = 1_000_000;
    recordSourceFailure('Awoko', new Error('timeout'), t0);
    expect(shouldSkipSource('Awoko', t0 + 30_000)).toBe(true);
    expect(shouldSkipSource('Awoko', t0 + 61_000)).toBe(false);
    recordSourceSuccess('Awoko');
    expect(shouldSkipSource('Awoko')).toBe(false);
    expect(sourceHealthSnapshot()[0].failures).toBe(0);
  });

  it('caps the backoff at one hour', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i += 1) recordSourceFailure('Awoko', new Error('down'), t0);
    expect(sourceHealthSnapshot(t0)[0].nextAttemptAt - t0).toBe(60 * 60_000);
  });
});
