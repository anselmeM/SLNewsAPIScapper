import { prisma } from '../db.js';

/**
 * Tiny key/value store shared by the cron worker and the web service.
 *
 * The hourly ingestion runs in its own Render process, so in-memory counters
 * would never reach `/api/stats` (served by the web service). This table is
 * created idempotently on first use and stores only small JSON snapshots.
 */
let ready: Promise<void> | null = null;

async function ensureTable(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS runtime_state (
          key text PRIMARY KEY,
          value jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
    })().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

export async function putRuntimeState(key: string, value: unknown): Promise<void> {
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO runtime_state (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    key,
    JSON.stringify(value),
  );
}

export async function getRuntimeState<T>(key: string): Promise<T | null> {
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<Array<{ value: T }>>(
      `SELECT value FROM runtime_state WHERE key = $1`,
      key,
    );
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
}
