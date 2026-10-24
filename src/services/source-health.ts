/**
 * Per-source ingestion health with exponential backoff.
 *
 * A feed that keeps failing should not be hammered every hour: each failure
 * doubles the wait up to an hour, and one success clears the record. State is
 * intentionally in-process (the worker is a single Render cron instance); the
 * snapshot is exposed through the stats API so operators can see which outlet
 * is down without reading logs.
 */
export interface SourceHealthEntry {
  source: string;
  failures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  nextAttemptAt: number;
}

const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

const entries = new Map<string, SourceHealthEntry>();

export function recordSourceSuccess(source: string, now = Date.now()): void {
  entries.set(source, {
    source,
    failures: 0,
    lastSuccessAt: now,
    lastFailureAt: null,
    lastError: null,
    nextAttemptAt: 0,
  });
}

export function recordSourceFailure(source: string, error: unknown, now = Date.now()): void {
  const previous = entries.get(source);
  const failures = (previous?.failures ?? 0) + 1;
  const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
  entries.set(source, {
    source,
    failures,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastFailureAt: now,
    lastError: error instanceof Error ? error.message : String(error),
    nextAttemptAt: now + backoff,
  });
}

export function shouldSkipSource(source: string, now = Date.now()): boolean {
  const entry = entries.get(source);
  return entry !== undefined && now < entry.nextAttemptAt;
}

export function sourceHealthSnapshot(now = Date.now()): Array<SourceHealthEntry & { skip: boolean }> {
  return [...entries.values()]
    .map((entry) => ({ ...entry, skip: now < entry.nextAttemptAt }))
    .sort((a, b) => a.source.localeCompare(b.source));
}

/** Test-only reset. */
export function __resetSourceHealth(): void {
  entries.clear();
}
