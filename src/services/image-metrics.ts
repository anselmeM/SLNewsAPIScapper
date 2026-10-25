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
  stuck_runs: number;
  alert: boolean;
  alert_reason: string | null;
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
  stuck_runs: 0,
  alert: false,
  alert_reason: null,
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

/**
 * Detects a stuck backlog: the sweep reports plenty of missing images, run after
 * run, without the number falling. That points at failing preview extraction,
 * not a queue that is simply draining.
 */
export function evaluateImageBackfillAlert(input: {
  missingRemaining: number;
  previous: ImageBackfillStats | null;
  threshold?: number;
}): { stuck_runs: number; alert: boolean; alert_reason: string | null } {
  const threshold = input.threshold ?? positive(process.env.IMAGE_BACKFILL_ALERT_THRESHOLD) ?? 50;
  const previous = input.previous;
  const stillHigh = input.missingRemaining >= threshold;
  const noProgress =
    previous !== null && previous.missing_remaining > 0 && input.missingRemaining >= previous.missing_remaining;
  const stuckRuns = stillHigh && noProgress ? (previous?.stuck_runs ?? 0) + 1 : 0;
  const alert = stuckRuns >= 2;
  return {
    stuck_runs: stuckRuns,
    alert,
    alert_reason: alert
      ? `missing_remaining has stayed at or above ${threshold} for ${stuckRuns} runs; check preview-image extraction`
      : null,
  };
}

export function recordImageBackfill(input: {
  filled: number;
  revalidated: number;
  missingRemaining: number;
  limits: ImageBackfillLimits;
  durationMs: number;
  stuckRuns?: number;
  alert?: boolean;
  alertReason?: string | null;
}): void {
  stats = {
    filled: input.filled,
    revalidated: input.revalidated,
    missing_remaining: input.missingRemaining,
    limits: input.limits,
    last_run_at: Date.now(),
    last_duration_ms: input.durationMs,
    stuck_runs: input.stuckRuns ?? 0,
    alert: input.alert ?? false,
    alert_reason: input.alertReason ?? null,
  };
}

export function imageBackfillSnapshot(): ImageBackfillStats {
  return { ...stats, limits: { ...stats.limits } };
}
