/**
 * Image-backfill observability and adaptive budgets.
 *
 * The sweep fills missing images and revalidates recent URLs in bounded batches.
 * Once the 30-day missing backlog is drained, the per-run budgets double so new
 * stories get fingerprinted images on the next cycle instead of drifting in the
 * queue. Env vars override both modes.
 */
export interface ImageBackfillLimits {
  missing: number;
  revalidate: number;
  reason: 'base' | 'backlog-clear' | 'env';
}

export interface ImageBackfillStats {
  filled: number;
  revalidated: number;
  missing_remaining: number;
  limits: ImageBackfillLimits;
  last_run_at: number | null;
  last_duration_ms: number | null;
}

const BASE = { missing: 15, revalidate: 25 } as const;
const CLEAR = { missing: 30, revalidate: 50 } as const;

let stats: ImageBackfillStats = {
  filled: 0,
  revalidated: 0,
  missing_remaining: 0,
  limits: { ...BASE, reason: 'base' },
  last_run_at: null,
  last_duration_ms: null,
};

/** Bounded-batch sizes for this run; the backlog total decides the mode. */
export function imageBackfillLimits(
  missingTotal: number,
  env: Record<string, string | undefined> = process.env,
): ImageBackfillLimits {
  const envMissing = positive(env.IMAGE_BACKFILL_MISSING_LIMIT);
  const envRevalidate = positive(env.IMAGE_BACKFILL_REVALIDATE_LIMIT);
  if (envMissing || envRevalidate) {
    return {
      missing: envMissing ?? BASE.missing,
      revalidate: envRevalidate ?? BASE.revalidate,
      reason: 'env',
    };
  }
  if (missingTotal === 0) return { ...CLEAR, reason: 'backlog-clear' };
  return { ...BASE, reason: 'base' };
}

function positive(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function recordImageBackfill(input: {
  filled: number;
  revalidated: number;
  missingRemaining: number;
  limits: ImageBackfillLimits;
  durationMs: number;
}): void {
  stats = {
    filled: input.filled,
    revalidated: input.revalidated,
    missing_remaining: input.missingRemaining,
    limits: input.limits,
    last_run_at: Date.now(),
    last_duration_ms: input.durationMs,
  };
}

export function imageBackfillSnapshot(): ImageBackfillStats {
  return { ...stats, limits: { ...stats.limits } };
}
