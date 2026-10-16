import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { verifyToken } from '@clerk/backend';
import { TokenVerificationErrorReason } from '@clerk/backend/errors';
import { prisma } from '../db.js';
import logger from '../logger.js';
import { describeVerificationFailure, parseAuthorizedParties, verifySessionToken } from '../auth/clerk.js';

vi.mock('../db.js', () => ({
  prisma: {
    article: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
    },
    video: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
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

// The mock boundary sits at Clerk's own verifier, so no test performs network
// I/O (no JWKS fetch) while our wrapper, middleware and app still run for real.
vi.mock('@clerk/backend', () => ({ verifyToken: vi.fn() }));

const findMany = prisma.article.findMany as unknown as ReturnType<typeof vi.fn>;
const count = prisma.article.count as unknown as ReturnType<typeof vi.fn>;
const queryRaw = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;
const logDebug = logger.debug as unknown as ReturnType<typeof vi.fn>;
const logInfo = logger.info as unknown as ReturnType<typeof vi.fn>;
const logWarn = logger.warn as unknown as ReturnType<typeof vi.fn>;
const logError = logger.error as unknown as ReturnType<typeof vi.fn>;
const verifyTokenMock = vi.mocked(verifyToken);

const TEST_API_KEY = 'test-key-123';
const TEST_CLERK_SECRET_KEY = 'sk_test_clerk_secret';
const ALLOWED_PARTY = 'https://pwa.example.com';
const VALID_JWT = 'header.payload.valid-signature';
const WRONG_SIGNATURE_JWT = 'header.payload.wrong-signature';
const EXPIRED_JWT = 'header.payload.expired';
const MALFORMED_JWT = 'not.a.jwt';
const AZP_MISMATCH_JWT = 'header.payload.other-party';

type FakeClaims = { sub: string; azp: string };
type FakeToken = FakeClaims | { reason: string };

const fakeTokens: Record<string, FakeToken> = {
  [VALID_JWT]: { sub: 'user_2abc', azp: ALLOWED_PARTY },
  [AZP_MISMATCH_JWT]: { sub: 'user_2abc', azp: 'https://evil.example.com' },
  [WRONG_SIGNATURE_JWT]: { reason: TokenVerificationErrorReason.TokenInvalidSignature },
  [EXPIRED_JWT]: { reason: TokenVerificationErrorReason.TokenExpired },
};

/**
 * Clerk's SDK rejects with an Error carrying a stable `reason` code (its bundled
 * entry inlines its own error class, so `instanceof` cannot be used — see
 * `describeVerificationFailure`). Mirror that shape here.
 */
function clerkError(reason: string): Error {
  return Object.assign(new Error('Token verification failed'), { reason });
}

/**
 * Mirrors the contract of Clerk's SDK: `authorizedParties` is enforced against
 * the token's `azp` claim and violations surface as a verification error, while
 * expired/unsigned/malformed tokens are rejected outright.
 */
function authorize(claims: FakeClaims, authorizedParties: string[] | undefined): FakeClaims {
  if (authorizedParties && !authorizedParties.includes(claims.azp)) {
    throw clerkError(TokenVerificationErrorReason.TokenInvalidAuthorizedParties);
  }
  return claims;
}

const originalApiKey = process.env.API_KEY;
const originalClerkSecretKey = process.env.CLERK_SECRET_KEY;
const originalClerkAuthorizedParties = process.env.CLERK_AUTHORIZED_PARTIES;
const originalNodeEnv = process.env.NODE_ENV;

process.env.API_KEY = TEST_API_KEY;
process.env.CLERK_SECRET_KEY = TEST_CLERK_SECRET_KEY;
process.env.CLERK_AUTHORIZED_PARTIES = ALLOWED_PARTY;

function restoreEnv(name: string, value: string | undefined): void {
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

  process.env.API_KEY = TEST_API_KEY;
  process.env.CLERK_SECRET_KEY = TEST_CLERK_SECRET_KEY;
  process.env.CLERK_AUTHORIZED_PARTIES = ALLOWED_PARTY;

  findMany.mockResolvedValue([]);
  count.mockResolvedValue(1);
  queryRaw.mockResolvedValue([{ '?column?': 1 }]);

  verifyTokenMock.mockImplementation(async (token, options) => {
    const entry = fakeTokens[token];
    if (!entry) {
      throw clerkError(TokenVerificationErrorReason.TokenInvalid);
    }
    if ('reason' in entry) {
      throw clerkError(entry.reason);
    }
    return authorize(entry, options?.authorizedParties) as unknown as Awaited<ReturnType<typeof verifyToken>>;
  });
});

afterAll(() => {
  restoreEnv('API_KEY', originalApiKey);
  restoreEnv('CLERK_SECRET_KEY', originalClerkSecretKey);
  restoreEnv('CLERK_AUTHORIZED_PARTIES', originalClerkAuthorizedParties);
  restoreEnv('NODE_ENV', originalNodeEnv);
});

describe('static API key (PWA compatibility)', () => {
  it('still authorizes /api/news with the static API key', async () => {
    const res = await app.get('/api/news').set('Authorization', `Bearer ${TEST_API_KEY}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // The static path must never fall through to Clerk.
    expect(verifyTokenMock).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: 'static', path: '/api/news' }),
      expect.any(String),
    );
  });

  it('still authorizes /v1/news with a lowercase bearer scheme', async () => {
    const res = await app.get('/v1/news').set('Authorization', `bearer ${TEST_API_KEY}`);

    expect(res.status).toBe(200);
    expect(verifyTokenMock).not.toHaveBeenCalled();
  });

  it('requires authentication on /api/news without a token', async () => {
    const res = await app.get('/api/news');

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Unauthorized');
  });
});

describe('Clerk session JWT', () => {
  it('authorizes a verified session JWT on /v1/news and logs scheme=clerk', async () => {
    const res = await app.get('/v1/news').set('Authorization', `Bearer ${VALID_JWT}`);

    expect(res.status).toBe(200);
    expect(verifyTokenMock).toHaveBeenCalledWith(
      VALID_JWT,
      expect.objectContaining({ secretKey: TEST_CLERK_SECRET_KEY, authorizedParties: [ALLOWED_PARTY] }),
    );
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: 'clerk', sub: 'user_2abc', path: '/v1/news' }),
      expect.any(String),
    );
  });

  it('never logs the bearer token', async () => {
    await app.get('/v1/news').set('Authorization', `Bearer ${VALID_JWT}`);
    await app.get('/v1/news').set('Authorization', `Bearer ${WRONG_SIGNATURE_JWT}`);

    const logged = JSON.stringify([
      ...logDebug.mock.calls,
      ...logInfo.mock.calls,
      ...logWarn.mock.calls,
      ...logError.mock.calls,
    ]);

    expect(logged).not.toContain(VALID_JWT);
    expect(logged).not.toContain(WRONG_SIGNATURE_JWT);
  });

  it('rejects a JWT with a wrong signature', async () => {
    const res = await app.get('/v1/news').set('Authorization', `Bearer ${WRONG_SIGNATURE_JWT}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Unauthorized');
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/v1/news', reason: TokenVerificationErrorReason.TokenInvalidSignature }),
      expect.any(String),
    );
  });

  it('rejects an expired JWT', async () => {
    const res = await app.get('/v1/news').set('Authorization', `Bearer ${EXPIRED_JWT}`);

    expect(res.status).toBe(401);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: TokenVerificationErrorReason.TokenExpired }),
      expect.any(String),
    );
  });

  it('rejects a malformed JWT', async () => {
    const res = await app.get('/v1/news').set('Authorization', `Bearer ${MALFORMED_JWT}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Unauthorized');
  });

  it('rejects a JWT whose azp is not in CLERK_AUTHORIZED_PARTIES', async () => {
    const res = await app.get('/v1/news').set('Authorization', `Bearer ${AZP_MISMATCH_JWT}`);

    expect(res.status).toBe(401);
    expect(verifyTokenMock).toHaveBeenCalledWith(
      AZP_MISMATCH_JWT,
      expect.objectContaining({ authorizedParties: [ALLOWED_PARTY] }),
    );
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: TokenVerificationErrorReason.TokenInvalidAuthorizedParties }),
      expect.any(String),
    );
  });

  it('does not restrict by party when CLERK_AUTHORIZED_PARTIES is unset', async () => {
    delete process.env.CLERK_AUTHORIZED_PARTIES;

    const res = await app.get('/v1/news').set('Authorization', `Bearer ${AZP_MISMATCH_JWT}`);

    expect(res.status).toBe(200);
    expect(verifyTokenMock.mock.calls[0][1]).not.toHaveProperty('authorizedParties');
  });

  it('logs the SDK reason code, never the token or the SDK message', async () => {
    const res = await app.get('/v1/news').set('Authorization', `Bearer ${WRONG_SIGNATURE_JWT}`);

    expect(res.status).toBe(401);
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0][0]).toEqual({
      path: '/v1/news',
      reason: TokenVerificationErrorReason.TokenInvalidSignature,
    });
  });

  it('only ever logs reason codes Clerk defines', () => {
    // Real SDK behaviour: a malformed token rejects with reason 'token-invalid'
    // (its error class is inlined in the bundled entry, so instanceof against
    // @clerk/backend/errors does not match — this is the regression guard).
    expect(describeVerificationFailure(Object.assign(new Error('nope'), { reason: 'token-invalid' }))).toBe(
      'token-invalid',
    );
    expect(describeVerificationFailure(new Error('nope'))).toBe('verification-failed');
    expect(describeVerificationFailure({ reason: 'not-a-clerk-reason' })).toBe('verification-failed');
    expect(describeVerificationFailure({ reason: 42 })).toBe('verification-failed');
    expect(describeVerificationFailure(undefined)).toBe('verification-failed');
  });
});

describe('Clerk not configured', () => {
  it('rejects a JWT exactly as an invalid static key is rejected', async () => {
    delete process.env.CLERK_SECRET_KEY;

    const jwtRes = await app.get('/v1/news').set('Authorization', `Bearer ${VALID_JWT}`);
    const badKeyRes = await app.get('/v1/news').set('Authorization', 'Bearer not-the-key');

    expect(jwtRes.status).toBe(401);
    expect(jwtRes.body).toEqual(badKeyRes.body);
    // Unchanged 401 message from before Clerk support existed.
    expect(jwtRes.body.error).toBe('Unauthorized — provide a valid API key via Authorization: Bearer <key>');
    expect(verifyTokenMock).not.toHaveBeenCalled();
  });

  it('still authorizes the static key while Clerk is unconfigured', async () => {
    delete process.env.CLERK_SECRET_KEY;

    const res = await app.get('/v1/news').set('Authorization', `Bearer ${TEST_API_KEY}`);

    expect(res.status).toBe(200);
    expect(verifyTokenMock).not.toHaveBeenCalled();
  });

  it('logs a rejected static key at debug level only', async () => {
    delete process.env.CLERK_SECRET_KEY;

    const res = await app.get('/api/news').set('Authorization', 'Bearer not-the-key');

    expect(res.status).toBe(401);
    expect(logWarn).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/news', credentials: 'invalid-static-key' }),
      expect.any(String),
    );
  });

  it('logs missing credentials at debug level', async () => {
    delete process.env.CLERK_SECRET_KEY;

    const res = await app.get('/api/news');

    expect(res.status).toBe(401);
    expect(logDebug).toHaveBeenCalledWith(expect.objectContaining({ credentials: 'missing' }), expect.any(String));
  });
});

describe('server misconfiguration', () => {
  it('keeps the 500 path when neither API_KEY nor Clerk is configured', async () => {
    delete process.env.API_KEY;
    delete process.env.CLERK_SECRET_KEY;

    const res = await app.get('/v1/news').set('Authorization', `Bearer ${VALID_JWT}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Server misconfiguration: API_KEY is not set');
    expect(logError).toHaveBeenCalled();
    expect(verifyTokenMock).not.toHaveBeenCalled();
  });

  it('treats a blank API_KEY as unset when Clerk is unconfigured', async () => {
    process.env.API_KEY = '';
    delete process.env.CLERK_SECRET_KEY;

    const res = await app.get('/api/news');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Server misconfiguration: API_KEY is not set');
  });
});

describe('public endpoints', () => {
  it('stays open without credentials even when nothing is configured', async () => {
    delete process.env.API_KEY;
    delete process.env.CLERK_SECRET_KEY;

    const res = await app.get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('reports the accepted credential types on GET /', async () => {
    const res = await app.get('/');

    expect(res.status).toBe(200);
    expect(res.body.auth).toContain('static API key');
    expect(res.body.auth).toContain('Clerk session JWT');
  });
});

describe('documentation', () => {
  it('documents both credential types on the security scheme and the news operations', async () => {
    const { swaggerSpec } = await import('../config/swagger.js');
    const spec = swaggerSpec as {
      components?: { securitySchemes?: Record<string, { description?: string }> };
      paths?: Record<string, { get?: { description?: string } }>;
    };

    expect(spec.components?.securitySchemes?.bearerAuth?.description).toContain('Clerk session JWT');
    for (const path of ['/api/news', '/v1/news']) {
      expect(spec.paths?.[path]?.get?.description).toContain('Clerk session JWT');
    }
  });
});

describe('verifySessionToken (Clerk SDK boundary)', () => {
  it('passes the secret key and the parsed authorized parties to Clerk', async () => {
    process.env.CLERK_AUTHORIZED_PARTIES = 'https://a.example.com, https://pwa.example.com';

    const claims = await verifySessionToken(VALID_JWT);

    expect(claims.sub).toBe('user_2abc');
    expect(verifyTokenMock).toHaveBeenCalledWith(VALID_JWT, {
      secretKey: TEST_CLERK_SECRET_KEY,
      authorizedParties: ['https://a.example.com', 'https://pwa.example.com'],
    });
  });

  it('refuses to verify when CLERK_SECRET_KEY is missing', async () => {
    delete process.env.CLERK_SECRET_KEY;

    await expect(verifySessionToken(VALID_JWT)).rejects.toThrow('CLERK_SECRET_KEY is not configured');
    expect(verifyTokenMock).not.toHaveBeenCalled();
  });

  it('parses CLERK_AUTHORIZED_PARTIES as a trimmed, comma-separated list', () => {
    expect(parseAuthorizedParties(undefined)).toBeUndefined();
    expect(parseAuthorizedParties('')).toBeUndefined();
    expect(parseAuthorizedParties('  ,  ')).toBeUndefined();
    expect(parseAuthorizedParties(' https://a.example.com ,https://b.example.com ')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });
});
