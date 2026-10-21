import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { prisma } from '../db.js';
import logger, { LOG_REDACT_PATHS, LOG_REDACTION } from '../logger.js';

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

const TEST_API_KEY = 'test-key-123';
const originalApiKey = process.env.API_KEY;
const originalClerkSecretKey = process.env.CLERK_SECRET_KEY;
const originalClerkAuthorizedParties = process.env.CLERK_AUTHORIZED_PARTIES;
const originalNodeEnv = process.env.NODE_ENV;

process.env.API_KEY = TEST_API_KEY;
process.env.NODE_ENV = 'test';
// Keep the auth middleware deterministic regardless of the developer's shell.
delete process.env.CLERK_SECRET_KEY;
delete process.env.CLERK_AUTHORIZED_PARTIES;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

let app: ReturnType<typeof request>;
let expressApp: Express;

beforeAll(async () => {
  const { default: importedApp } = await import('../server.js');
  expressApp = importedApp as unknown as Express;
  app = request(expressApp);
});

afterAll(() => {
  restoreEnv('API_KEY', originalApiKey);
  restoreEnv('CLERK_SECRET_KEY', originalClerkSecretKey);
  restoreEnv('CLERK_AUTHORIZED_PARTIES', originalClerkAuthorizedParties);
  restoreEnv('NODE_ENV', originalNodeEnv);
});

describe('request logging redaction', () => {
  it('exports the credential-bearing headers as redaction paths', () => {
    expect(LOG_REDACT_PATHS).toContain('req.headers.authorization');
    expect(LOG_REDACT_PATHS).toContain('req.headers.cookie');
    expect(LOG_REDACTION.censor).toBe('[redacted]');
  });

  it('redacts Authorization and Cookie headers before they are written', () => {
    const lines: string[] = [];
    const destination: pino.DestinationStream = {
      write(message: string) {
        lines.push(message);
      },
    };
    // Same configuration pino-http receives in server.ts (it applies these
    // options to a child logger on every request).
    const testLogger = pino({ level: 'info', redact: LOG_REDACTION }, destination);

    testLogger.info(
      {
        req: {
          method: 'GET',
          url: '/api/news',
          headers: {
            authorization: 'Bearer super-secret-token',
            cookie: 'session=super-secret-cookie',
          },
        },
      },
      'request completed',
    );

    const output = lines.join('\n');
    expect(output).toContain('[redacted]');
    expect(output).not.toContain('super-secret-token');
    expect(output).not.toContain('super-secret-cookie');
  });
});

describe('trust proxy', () => {
  it('uses a numeric hop count instead of the permissive boolean', () => {
    // express-rate-limit rejects `true`; a number is what lets the limiter see
    // the real client IP from X-Forwarded-For without trusting forged values.
    expect(typeof expressApp.get('trust proxy')).toBe('number');
    expect(expressApp.get('trust proxy')).toBe(1);
  });
});

describe('timing-safe bearer comparison', () => {
  it('rejects a multibyte token with a matching JS length but different UTF-8 length as 401, not 500', async () => {
    const multibyteToken = 'é'.repeat(TEST_API_KEY.length);
    // Same .length as the key, twice the byte length: the old length-guarded
    // timingSafeEqual threw on this input and surfaced as a 500.
    expect(multibyteToken.length).toBe(TEST_API_KEY.length);
    expect(Buffer.byteLength(multibyteToken)).not.toBe(Buffer.byteLength(TEST_API_KEY));

    const res = await app.get('/api/news').set('Authorization', `Bearer ${multibyteToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Unauthorized');
  });

  it('still rejects a wrong token with 401', async () => {
    const res = await app.get('/api/news').set('Authorization', 'Bearer definitely-not-the-key');

    expect(res.status).toBe(401);
  });

  it('still authorizes the exact static key', async () => {
    (prisma.article.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const res = await app.get('/api/news').set('Authorization', `Bearer ${TEST_API_KEY}`);

    expect(res.status).toBe(200);
  });
});

describe('error handling', () => {
  it('turns a malformed JSON body into a 400 without logging the body', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    try {
      const res = await app
        .post('/api/news')
        .set('Content-Type', 'application/json')
        .send('{"apiKey":"super-secret-value",');

      expect(res.status).toBe(400);
      // 4xx bodies now carry the correlation id alongside the error message.
      expect(res.body).toEqual(expect.objectContaining({ error: 'Bad request' }));
      expect(res.body.request_id).toEqual(expect.any(String));
      expect(res.body.request_id).toBe(res.headers['x-request-id']);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [context] = warnSpy.mock.calls[0] as [Record<string, unknown>];
      // Only the error's identity and request path are logged — never the raw
      // error (body-parser attaches the offending body to it) nor a stack.
      expect(context).toMatchObject({ name: 'SyntaxError', status: 400, path: '/api/news' });
      expect(context).not.toHaveProperty('body');
      expect(context).not.toHaveProperty('stack');
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('super-secret-value');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('CORS', () => {
  it('exposes pagination and rate-limit headers to browser clients', async () => {
    const res = await app.get('/api/health').set('Origin', 'https://pwa.example.com');

    expect(res.headers['access-control-allow-origin']).toBe('*');
    const exposed = String(res.headers['access-control-expose-headers'] ?? '').toLowerCase();
    for (const header of [
      'X-Total-Count',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
    ]) {
      expect(exposed).toContain(header.toLowerCase());
    }
  });
});

describe('OpenAPI spec', () => {
  it('documents at least 8 operations in the current route layout', async () => {
    const { swaggerSpec } = await import('../config/swagger.js');
    const spec = swaggerSpec as { paths?: Record<string, Record<string, unknown>> };
    const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete']);
    const operationCount = Object.values(spec.paths ?? {}).reduce(
      (total, pathItem) => total + Object.keys(pathItem).filter((key) => httpMethods.has(key)).length,
      0,
    );

    expect(operationCount).toBeGreaterThanOrEqual(8);
    expect(spec.paths?.['/api/news']?.get).toBeDefined();
    expect(spec.paths?.['/v1/news']?.get).toBeDefined();
  });

  it('prefers the TypeScript route sources and falls back to compiled JavaScript', async () => {
    const { resolveApiGlobs } = await import('../config/swagger.js');

    // In this repo the TypeScript sources exist, so they are the spec source.
    expect(resolveApiGlobs()).toEqual([expect.stringMatching(/src\/routes\/\*\.ts$/)]);

    const tempRoot = mkdtempSync(path.join(tmpdir(), 'slnews-swagger-'));
    try {
      // Production image layout: only the compiled routes are shipped.
      mkdirSync(path.join(tempRoot, 'dist', 'routes'), { recursive: true });
      expect(resolveApiGlobs(tempRoot)).toEqual([expect.stringMatching(/dist\/routes\/\*\.js$/)]);

      // If both layouts exist, the readable TypeScript sources win.
      mkdirSync(path.join(tempRoot, 'src', 'routes'), { recursive: true });
      expect(resolveApiGlobs(tempRoot)).toEqual([expect.stringMatching(/src\/routes\/\*\.ts$/)]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('route file layout', () => {
  it('keeps the TypeScript sources that swagger-jsdoc reads', () => {
    expect(existsSync(path.join(process.cwd(), 'src', 'routes'))).toBe(true);
  });
});
