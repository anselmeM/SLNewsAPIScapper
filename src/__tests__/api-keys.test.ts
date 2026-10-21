import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { verifyToken } from '@clerk/backend';
import { prisma } from '../db.js';
import logger from '../logger.js';
import {
  API_KEY_CACHE_MAX_ENTRIES,
  API_KEY_PREFIX,
  SCOPES,
  clearApiKeyCache,
  generateApiKey,
  hashApiKey,
  parseScopes,
  verifyApiKey,
} from '../auth/apiKeys.js';

vi.mock('../db.js', () => ({
  prisma: {
    article: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    video: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    apiKey: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    apiKeyUsage: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../logger.js', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// The auth middleware's Clerk boundary is mocked (no network/JWKS); the Clerk
// wrapper itself still runs.
vi.mock('@clerk/backend', () => ({ verifyToken: vi.fn() }));

const apiKeyFindUnique = prisma.apiKey.findUnique as unknown as ReturnType<typeof vi.fn>;
const apiKeyUpdate = prisma.apiKey.update as unknown as ReturnType<typeof vi.fn>;
const apiKeyUsageUpsert = prisma.apiKeyUsage.upsert as unknown as ReturnType<typeof vi.fn>;
const articleFindMany = prisma.article.findMany as unknown as ReturnType<typeof vi.fn>;
const verifyTokenMock = vi.mocked(verifyToken);
const logDebug = logger.debug as unknown as ReturnType<typeof vi.fn>;
const logInfo = logger.info as unknown as ReturnType<typeof vi.fn>;
const logWarn = logger.warn as unknown as ReturnType<typeof vi.fn>;
const logError = logger.error as unknown as ReturnType<typeof vi.fn>;

const STATIC_KEY = 'static-test-key';
const VALID_JWT = 'header.payload.valid-signature';

const originalEnv = {
  API_KEY: process.env.API_KEY,
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
  CLERK_AUTHORIZED_PARTIES: process.env.CLERK_AUTHORIZED_PARTIES,
  STATIC_KEY_SCOPES: process.env.STATIC_KEY_SCOPES,
  CLERK_SCOPES: process.env.CLERK_SCOPES,
  API_KEY_CACHE_TTL_MS: process.env.API_KEY_CACHE_TTL_MS,
  NODE_ENV: process.env.NODE_ENV,
};

function restoreEnv(name: keyof typeof originalEnv, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

let app: ReturnType<typeof request>;

beforeAll(async () => {
  const { default: expressApp } = await import('../server.js');
  app = request(expressApp as unknown as Express);
});

beforeEach(() => {
  vi.clearAllMocks();
  clearApiKeyCache();

  process.env.API_KEY = STATIC_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CLERK_AUTHORIZED_PARTIES;
  delete process.env.STATIC_KEY_SCOPES;
  delete process.env.CLERK_SCOPES;
  delete process.env.API_KEY_CACHE_TTL_MS;

  apiKeyFindUnique.mockResolvedValue(null);
  apiKeyUpdate.mockResolvedValue({});
  apiKeyUsageUpsert.mockResolvedValue({});
  articleFindMany.mockResolvedValue([]);
  verifyTokenMock.mockImplementation(
    async () => ({ sub: 'user_test' }) as unknown as Awaited<ReturnType<typeof verifyToken>>,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  (Object.keys(originalEnv) as Array<keyof typeof originalEnv>).forEach((name) => restoreEnv(name, originalEnv[name]));
});

function activeRecord(
  overrides: Partial<{ id: number; scopes: string[]; active: boolean; expiresAt: Date | null }> = {},
) {
  return {
    id: overrides.id ?? 7,
    scopes: overrides.scopes ?? [SCOPES.V1_READ],
    active: overrides.active ?? true,
    expiresAt: overrides.expiresAt ?? null,
  };
}

/** Route a raw key to a fixed DB record (and any other key to "unknown"). */
function stubKey(rawKey: string, record: ReturnType<typeof activeRecord>): void {
  const keyHash = hashApiKey(rawKey);
  apiKeyFindUnique.mockImplementation(async ({ where }: { where: { keyHash: string } }) =>
    where.keyHash === keyHash ? record : null,
  );
}

describe('key hashing and generation', () => {
  it('hashes deterministically to 64 hex chars', () => {
    const raw = 'slk_example_key_value';
    const hash = hashApiKey(raw);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(raw)).toBe(hash);
    expect(hashApiKey(`${raw}x`)).not.toBe(hash);
    expect(hash).not.toContain(raw);
  });

  it('generates slk_ keys with 32 random bytes (base64url, no padding)', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey()));

    expect(keys.size).toBe(50);
    for (const key of keys) {
      expect(key).toMatch(/^slk_[A-Za-z0-9_-]{43}$/);
      expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    }
  });

  it('never returns the same key twice', () => {
    expect(generateApiKey()).not.toBe(generateApiKey());
  });

  it('parses, trims and de-duplicates comma-separated scopes', () => {
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes('')).toEqual([]);
    expect(parseScopes('  ,  ')).toEqual([]);
    expect(parseScopes('v1:read')).toEqual(['v1:read']);
    expect(parseScopes(' v1:read , internal:read ,v1:read')).toEqual(['v1:read', 'internal:read']);
  });
});

describe('verifyApiKey', () => {
  it('returns the id and stored scopes for an active, unexpired key', async () => {
    const rawKey = generateApiKey();
    apiKeyFindUnique.mockResolvedValueOnce(activeRecord({ id: 7, scopes: [SCOPES.V1_READ] }));

    await expect(verifyApiKey(rawKey)).resolves.toEqual({ id: 7, scopes: [SCOPES.V1_READ] });
    expect(apiKeyFindUnique).toHaveBeenCalledWith({
      where: { keyHash: hashApiKey(rawKey) },
      select: { id: true, scopes: true, active: true, expiresAt: true },
    });
  });

  it('rejects revoked keys', async () => {
    apiKeyFindUnique.mockResolvedValueOnce(activeRecord({ active: false }));

    await expect(verifyApiKey(generateApiKey())).resolves.toBeNull();
  });

  it('rejects expired keys but accepts future expiry', async () => {
    apiKeyFindUnique.mockResolvedValueOnce(activeRecord({ expiresAt: new Date(Date.now() - 1_000) }));
    await expect(verifyApiKey(generateApiKey())).resolves.toBeNull();

    apiKeyFindUnique.mockResolvedValueOnce(activeRecord({ id: 8, expiresAt: new Date(Date.now() + 60_000) }));
    await expect(verifyApiKey(generateApiKey())).resolves.toEqual({ id: 8, scopes: [SCOPES.V1_READ] });
  });

  it('returns null for unknown keys', async () => {
    apiKeyFindUnique.mockResolvedValueOnce(null);
    await expect(verifyApiKey(generateApiKey())).resolves.toBeNull();
  });

  it('rejects malformed slk_ tokens without touching the database', async () => {
    apiKeyFindUnique.mockClear();

    await expect(verifyApiKey('slk_short')).resolves.toBeNull();
    await expect(verifyApiKey(`slk_${'a'.repeat(42)}`)).resolves.toBeNull();
    await expect(verifyApiKey('not-a-key')).resolves.toBeNull();

    expect(apiKeyFindUnique).not.toHaveBeenCalled();
  });

  it('throws (so callers can answer 503) when the database fails', async () => {
    apiKeyFindUnique.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(verifyApiKey(generateApiKey())).rejects.toThrow('database unavailable');
  });
});

describe('verification cache', () => {
  it('caches positive results', async () => {
    const rawKey = generateApiKey();
    apiKeyFindUnique.mockResolvedValue(activeRecord({ id: 11 }));

    await verifyApiKey(rawKey);
    await verifyApiKey(rawKey);

    expect(apiKeyFindUnique).toHaveBeenCalledTimes(1);
  });

  it('caches negative results briefly', async () => {
    const rawKey = generateApiKey();
    apiKeyFindUnique.mockResolvedValue(null);

    await expect(verifyApiKey(rawKey)).resolves.toBeNull();
    await expect(verifyApiKey(rawKey)).resolves.toBeNull();

    expect(apiKeyFindUnique).toHaveBeenCalledTimes(1);
  });

  it('re-queries after clearApiKeyCache()', async () => {
    const rawKey = generateApiKey();
    apiKeyFindUnique.mockResolvedValue(null);

    await verifyApiKey(rawKey);
    clearApiKeyCache();
    await verifyApiKey(rawKey);

    expect(apiKeyFindUnique).toHaveBeenCalledTimes(2);
  });

  it('expires positive entries after API_KEY_CACHE_TTL_MS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T12:00:00.000Z'));
    process.env.API_KEY_CACHE_TTL_MS = '1000';
    const rawKey = generateApiKey();
    apiKeyFindUnique.mockResolvedValue(activeRecord());

    await verifyApiKey(rawKey);
    vi.setSystemTime(new Date('2026-08-07T12:00:00.900Z'));
    await verifyApiKey(rawKey);
    expect(apiKeyFindUnique).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-08-07T12:00:02.000Z'));
    await verifyApiKey(rawKey);
    expect(apiKeyFindUnique).toHaveBeenCalledTimes(2);
  });

  it('expires negative entries after 5s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T12:00:00.000Z'));
    const rawKey = generateApiKey();
    apiKeyFindUnique.mockResolvedValue(null);

    await verifyApiKey(rawKey);
    vi.setSystemTime(new Date('2026-08-07T12:00:04.999Z'));
    await verifyApiKey(rawKey);
    expect(apiKeyFindUnique).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-08-07T12:00:05.001Z'));
    await verifyApiKey(rawKey);
    expect(apiKeyFindUnique).toHaveBeenCalledTimes(2);
  });

  it('bounds the cache and evicts the oldest entry', async () => {
    apiKeyFindUnique.mockResolvedValue(null);
    const rawKeys = Array.from({ length: API_KEY_CACHE_MAX_ENTRIES + 1 }, () => generateApiKey());

    for (const rawKey of rawKeys) {
      await verifyApiKey(rawKey);
    }
    const callsAfterFill = apiKeyFindUnique.mock.calls.length;
    expect(callsAfterFill).toBe(API_KEY_CACHE_MAX_ENTRIES + 1);

    // The first key was evicted, so it must be looked up again...
    await verifyApiKey(rawKeys[0]);
    expect(apiKeyFindUnique).toHaveBeenCalledTimes(callsAfterFill + 1);

    // ...while the newest key is still cached.
    await verifyApiKey(rawKeys[rawKeys.length - 1]);
    expect(apiKeyFindUnique).toHaveBeenCalledTimes(callsAfterFill + 1);
  });
});

describe('usage metering', () => {
  it("upserts today's UTC usage and stamps lastUsedAt on success", async () => {
    const rawKey = generateApiKey();
    apiKeyFindUnique.mockResolvedValue(activeRecord({ id: 21 }));

    await verifyApiKey(rawKey);

    await vi.waitFor(() => expect(apiKeyUsageUpsert).toHaveBeenCalledTimes(1));
    expect(apiKeyUpdate).toHaveBeenCalledTimes(1);
    expect(apiKeyUpdate).toHaveBeenCalledWith({ where: { id: 21 }, data: { lastUsedAt: expect.any(Date) } });

    const upsertArgs = apiKeyUsageUpsert.mock.calls[0][0];
    expect(upsertArgs).toEqual({
      where: { apiKeyId_day: { apiKeyId: 21, day: expect.any(Date) } },
      update: { requests: { increment: 1 } },
      create: { apiKeyId: 21, day: expect.any(Date), requests: 1 },
    });
    const day = upsertArgs.where.apiKeyId_day.day as Date;
    expect(day.getUTCHours()).toBe(0);
    expect(day.getUTCMinutes()).toBe(0);
    expect(day.getUTCSeconds()).toBe(0);
  });

  it('counts every request but writes lastUsedAt at most once per minute', async () => {
    const rawKey = generateApiKey();
    apiKeyFindUnique.mockResolvedValue(activeRecord({ id: 22 }));

    await verifyApiKey(rawKey);
    await verifyApiKey(rawKey);

    await vi.waitFor(() => expect(apiKeyUsageUpsert).toHaveBeenCalledTimes(2));
    expect(apiKeyUpdate).toHaveBeenCalledTimes(1);
  });

  it('never fails authentication when metering writes fail', async () => {
    const rawKey = generateApiKey();
    apiKeyFindUnique.mockResolvedValue(activeRecord({ id: 23 }));
    apiKeyUpdate.mockRejectedValue(new Error('write failed'));
    apiKeyUsageUpsert.mockRejectedValue(new Error('write failed'));

    await expect(verifyApiKey(rawKey)).resolves.toEqual({ id: 23, scopes: [SCOPES.V1_READ] });
    await vi.waitFor(() => expect(logWarn).toHaveBeenCalled());
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: 23, operation: 'usage' }),
      expect.any(String),
    );
  });
});

describe('scope enforcement on the HTTP surface', () => {
  it('lets a v1:read customer key read /v1 but not /api', async () => {
    const rawKey = generateApiKey();
    stubKey(rawKey, activeRecord({ id: 31, scopes: [SCOPES.V1_READ] }));

    const v1Res = await app.get('/v1/news').set('Authorization', `Bearer ${rawKey}`);
    expect(v1Res.status).toBe(200);

    const apiRes = await app.get('/api/news').set('Authorization', `Bearer ${rawKey}`);
    expect(apiRes.status).toBe(403);
    expect(apiRes.body).toEqual({
      error: 'Forbidden — credential lacks required scope',
      required_scope: SCOPES.INTERNAL_READ,
    });
  });

  it('lets an internal:read customer key read /api but not /v1', async () => {
    const rawKey = generateApiKey();
    stubKey(rawKey, activeRecord({ id: 32, scopes: [SCOPES.INTERNAL_READ] }));

    const apiRes = await app.get('/api/news').set('Authorization', `Bearer ${rawKey}`);
    expect(apiRes.status).toBe(200);

    const v1Res = await app.get('/v1/news').set('Authorization', `Bearer ${rawKey}`);
    expect(v1Res.status).toBe(403);
    expect(v1Res.body).toEqual({
      error: 'Forbidden — credential lacks required scope',
      required_scope: SCOPES.V1_READ,
    });
  });

  it('applies the internal scope to videos and its sync route, and v1:read to /v1/videos', async () => {
    const rawKey = generateApiKey();
    stubKey(rawKey, activeRecord({ id: 34, scopes: [SCOPES.V1_READ] }));

    expect((await app.get('/v1/videos').set('Authorization', `Bearer ${rawKey}`)).status).toBe(200);
    expect((await app.get('/api/videos').set('Authorization', `Bearer ${rawKey}`)).status).toBe(403);

    const syncRes = await app.post('/api/videos/sync').set('Authorization', `Bearer ${rawKey}`);
    expect(syncRes.status).toBe(403);
    expect(syncRes.body.required_scope).toBe(SCOPES.INTERNAL_READ);
  });

  it('splits /api/stats (internal:read) from /v1/stats (v1:read)', async () => {
    const rawKey = generateApiKey();
    stubKey(rawKey, activeRecord({ id: 33, scopes: [SCOPES.V1_READ] }));

    expect((await app.get('/v1/stats').set('Authorization', `Bearer ${rawKey}`)).status).toBe(200);
    const apiStats = await app.get('/api/stats').set('Authorization', `Bearer ${rawKey}`);
    expect(apiStats.status).toBe(403);
    expect(apiStats.body.required_scope).toBe(SCOPES.INTERNAL_READ);
  });

  it('requires authentication (401) when no credential is supplied', async () => {
    const res = await app.get('/api/news');
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Unauthorized');
  });

  it('rejects an unknown customer key with 401 without trying Clerk', async () => {
    process.env.CLERK_SECRET_KEY = 'sk_test_clerk_secret';
    apiKeyFindUnique.mockResolvedValue(null);

    const res = await app.get('/v1/news').set('Authorization', `Bearer ${generateApiKey()}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Unauthorized');
    expect(verifyTokenMock).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('keeps the static API key working on both surfaces by default', async () => {
    await expect(app.get('/api/news').set('Authorization', `Bearer ${STATIC_KEY}`)).resolves.toMatchObject({
      status: 200,
    });
    await expect(app.get('/v1/news').set('Authorization', `Bearer ${STATIC_KEY}`)).resolves.toMatchObject({
      status: 200,
    });
    expect(apiKeyFindUnique).not.toHaveBeenCalled();
  });

  it('honours a narrowed STATIC_KEY_SCOPES', async () => {
    process.env.STATIC_KEY_SCOPES = SCOPES.V1_READ;

    expect((await app.get('/v1/news').set('Authorization', `Bearer ${STATIC_KEY}`)).status).toBe(200);
    const apiRes = await app.get('/api/news').set('Authorization', `Bearer ${STATIC_KEY}`);
    expect(apiRes.status).toBe(403);
    expect(apiRes.body.required_scope).toBe(SCOPES.INTERNAL_READ);
  });

  it('gives Clerk session JWTs both scopes by default', async () => {
    process.env.CLERK_SECRET_KEY = 'sk_test_clerk_secret';

    expect((await app.get('/v1/news').set('Authorization', `Bearer ${VALID_JWT}`)).status).toBe(200);
    expect((await app.get('/api/news').set('Authorization', `Bearer ${VALID_JWT}`)).status).toBe(200);
    expect(verifyTokenMock).toHaveBeenCalledTimes(2);
  });

  it('honours a narrowed CLERK_SCOPES', async () => {
    process.env.CLERK_SECRET_KEY = 'sk_test_clerk_secret';
    process.env.CLERK_SCOPES = SCOPES.V1_READ;

    expect((await app.get('/v1/news').set('Authorization', `Bearer ${VALID_JWT}`)).status).toBe(200);
    const apiRes = await app.get('/api/news').set('Authorization', `Bearer ${VALID_JWT}`);
    expect(apiRes.status).toBe(403);
    expect(apiRes.body.required_scope).toBe(SCOPES.INTERNAL_READ);
  });

  it('returns 503 (not 401) when the database fails while verifying a customer key', async () => {
    apiKeyFindUnique.mockRejectedValue(new Error('database down'));

    const res = await app.get('/v1/news').set('Authorization', `Bearer ${generateApiKey()}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Authentication temporarily unavailable');
  });

  it('propagates revocation once the cache is cleared', async () => {
    const rawKey = generateApiKey();
    const record = activeRecord({ id: 41, scopes: [SCOPES.V1_READ] });
    stubKey(rawKey, record);

    expect((await app.get('/v1/news').set('Authorization', `Bearer ${rawKey}`)).status).toBe(200);

    record.active = false;
    clearApiKeyCache();
    expect((await app.get('/v1/news').set('Authorization', `Bearer ${rawKey}`)).status).toBe(401);
  });

  it('never logs the raw customer key', async () => {
    const rawKey = generateApiKey();
    stubKey(rawKey, activeRecord({ id: 51, scopes: [SCOPES.V1_READ] }));

    expect((await app.get('/v1/news').set('Authorization', `Bearer ${rawKey}`)).status).toBe(200);

    const logged = JSON.stringify([
      ...logDebug.mock.calls,
      ...logInfo.mock.calls,
      ...logWarn.mock.calls,
      ...logError.mock.calls,
    ]);
    expect(logged).not.toContain(rawKey);
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: 'api-key', keyId: 51, scopes: [SCOPES.V1_READ] }),
      expect.any(String),
    );
  });
});
