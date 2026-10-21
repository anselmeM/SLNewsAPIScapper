import crypto from 'node:crypto';
import { prisma } from '../db.js';
import logger from '../logger.js';
import { positiveIntFromEnv } from '../observability.js';

/**
 * Customer API keys: issuance, verification, caching and usage metering.
 *
 * Keys are stored only as a SHA-256 hash and are generated with a recognisable
 * `slk_` prefix. The prefix is part of the auth fast path: tokens that do not
 * look like a DB key are rejected without a database round-trip, so an invalid
 * or malicious credential cannot amplify into DB load.
 */

export const SCOPES = {
  V1_READ: 'v1:read',
  INTERNAL_READ: 'internal:read',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/** Every scope the product knows about, in a stable order. */
export const KNOWN_SCOPES: readonly Scope[] = [SCOPES.INTERNAL_READ, SCOPES.V1_READ];

/** Prefix identifying a DB-backed customer API key (vs. the static API_KEY). */
export const API_KEY_PREFIX = 'slk_';

/** Number of random bytes in a generated key (base64url ⇒ 43 chars). */
export const API_KEY_RANDOM_BYTES = 32;

/**
 * Exact shape of a generated customer key: `slk_` plus 43 unpadded base64url
 * characters. Checked before any database access so malformed `slk_` tokens
 * cannot force a lookup (and cannot churn the cache) under credential-guessing.
 */
export const API_KEY_PATTERN = /^slk_[A-Za-z0-9_-]{43}$/;

export const DEFAULT_API_KEY_CACHE_TTL_MS = 30_000;
export const API_KEY_NEGATIVE_CACHE_TTL_MS = 5_000;
export const API_KEY_CACHE_MAX_ENTRIES = 1_000;
export const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Parses a comma-separated scope list (env vars, CLI `--scopes`). Trims entries,
 * drops blanks and de-duplicates while preserving first-seen order.
 */
export function parseScopes(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0),
    ),
  );
}

/** SHA-256 hex digest of a raw key; this is the only representation stored. */
export function hashApiKey(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** A new random customer key: `slk_` + 32 bytes as base64url (no padding). */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${crypto.randomBytes(API_KEY_RANDOM_BYTES).toString('base64url')}`;
}

export interface VerifiedApiKey {
  id: number;
  scopes: string[];
}

interface CacheEntry {
  verified: VerifiedApiKey | null;
  expiresAt: number;
}

// Insertion-ordered Map used as a bounded LRU-ish cache: size cap with oldest
// eviction. Both positive (30 s default) and negative (5 s) results are cached.
const cache = new Map<string, CacheEntry>();

/** Clears the verification cache. Intended for tests and manual rotation. */
export function clearApiKeyCache(): void {
  cache.clear();
}

function cacheTtlMs(): number {
  return positiveIntFromEnv(process.env.API_KEY_CACHE_TTL_MS, DEFAULT_API_KEY_CACHE_TTL_MS);
}

function readCache(keyHash: string): VerifiedApiKey | null | undefined {
  const entry = cache.get(keyHash);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(keyHash);
    return undefined;
  }
  return entry.verified;
}

function writeCache(keyHash: string, verified: VerifiedApiKey | null): void {
  if (cache.size >= API_KEY_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(keyHash, {
    verified,
    expiresAt: Date.now() + (verified ? cacheTtlMs() : API_KEY_NEGATIVE_CACHE_TTL_MS),
  });
}

// Last `lastUsedAt` write per key, so the column is updated at most once/minute
// even when the verification itself comes from the cache.
const lastUsedWrites = new Map<number, number>();

function utcDayStart(nowMs: number): Date {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Records a successful use. Fire-and-forget by design: metering must never make
 * authentication fail (or slow down) and its failures are logged at warn level.
 */
function recordUsage(keyId: number, nowMs: number): void {
  const previous = lastUsedWrites.get(keyId);
  const updateLastUsed = previous === undefined || nowMs - previous >= LAST_USED_THROTTLE_MS;
  if (updateLastUsed) lastUsedWrites.set(keyId, nowMs);

  const day = utcDayStart(nowMs);

  void (async () => {
    if (updateLastUsed) {
      try {
        await prisma.apiKey.update({ where: { id: keyId }, data: { lastUsedAt: new Date(nowMs) } });
      } catch {
        logger.warn({ keyId, operation: 'lastUsedAt' }, 'Failed to record API key last use');
      }
    }

    try {
      await prisma.apiKeyUsage.upsert({
        where: { apiKeyId_day: { apiKeyId: keyId, day } },
        update: { requests: { increment: 1 } },
        create: { apiKeyId: keyId, day, requests: 1 },
      });
    } catch {
      logger.warn({ keyId, operation: 'usage' }, 'Failed to record API key usage');
    }
  })();
}

/**
 * Verifies a raw customer key against the database.
 *
 * - Returns `{ id, scopes }` when the key exists, is active and not expired.
 * - Returns `null` for unknown/revoked/expired keys (cached briefly).
 * - **Throws** on database errors so the caller can map that to a 503 instead of
 *   silently treating a DB outage as an invalid credential.
 */
export async function verifyApiKey(raw: string): Promise<VerifiedApiKey | null> {
  if (!API_KEY_PATTERN.test(raw)) return null;

  const keyHash = hashApiKey(raw);

  const cached = readCache(keyHash);
  if (cached !== undefined) {
    if (cached) recordUsage(cached.id, Date.now());
    return cached;
  }

  const record = await prisma.apiKey.findUnique({
    where: { keyHash },
    select: { id: true, scopes: true, active: true, expiresAt: true },
  });

  const nowMs = Date.now();
  const verified =
    record && record.active && (record.expiresAt === null || record.expiresAt.getTime() > nowMs)
      ? { id: record.id, scopes: record.scopes }
      : null;

  writeCache(keyHash, verified);
  if (verified) recordUsage(verified.id, nowMs);

  return verified;
}
