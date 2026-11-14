import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import pinoHttp from 'pino-http';
import newsRouter from './routes/news.js';
import v1Router from './routes/v1.js';
import videosRouter from './routes/videos.js';
import v1VideosRouter from './routes/v1-videos.js';
import statsRouter from './routes/stats.js';
import { prisma } from './db.js';
import { swaggerSpec } from './config/swagger.js';
import { describeAuthentication, requireAuthentication } from './auth/requireAuthentication.js';
import { requireScopes } from './auth/authorize.js';
import { SCOPES } from './auth/apiKeys.js';
import { assertRuntimeEnv } from './config/env.js';
import logger, { LOG_REDACTION } from './logger.js';
import { positiveIntFromEnv, requestIdMiddleware, runtimeMetrics } from './observability.js';

/**
 * Express `trust proxy` hop count. Render (and any other reverse proxy) sits in
 * front of the app, so the real client IP is in `X-Forwarded-For`. A numeric hop
 * count is required: `true` would trust any `X-Forwarded-For` value, letting a
 * caller forge its IP and bypass per-IP rate limiting (express-rate-limit
 * rejects the boolean form outright).
 */
function parseTrustProxyHops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1;
  const hops = Number(raw);
  return Number.isInteger(hops) && hops >= 0 ? hops : 1;
}

/**
 * Rate-limit key: the client IP, normalised through express-rate-limit's
 * `ipKeyGenerator` so IPv6 clients cannot cycle addresses inside their /64.
 *
 * Do NOT key on an arbitrary Authorization header: the limiter runs before
 * authentication, so an attacker could rotate invented bearer values and get a
 * fresh budget per request. Per-credential quotas belong after authentication.
 */
function rateLimitKey(req: express.Request): string {
  return ipKeyGenerator(req.ip ?? '');
}

/** Minimal logger surface the shutdown / fatal-error handlers need (pino-compatible). */
interface ShutdownLogger {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
}

/** The subset of `node:http`'s Server that the shutdown handler drives. */
export interface CloseableServer {
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections?: () => void;
}

export interface ShutdownHandlerOptions {
  /** Listening server; omitted in tests that never start one. */
  server?: CloseableServer;
  /** Prisma disconnect, injected so the handler never needs a live database. */
  disconnect: () => Promise<unknown>;
  logger: ShutdownLogger;
  /** Forced-exit deadline after the first signal (default 10s, as before). */
  forceExitMs?: number;
  exit?: (code: number) => void;
  /** Test/observability hook invoked immediately before a forced exit. */
  onForceExit?: () => void;
}

/**
 * Build a SIGTERM/SIGINT handler that drains the server, disconnects Prisma and
 * exits 0 — with a force-exit fallback if connections never drain.
 *
 * Lifecycle guarantees:
 * - Only the first signal starts a shutdown; later signals are ignored so they
 *   cannot race the in-flight close or restart the deadline.
 * - The deadline timer is `unref()`ed and cleared on the graceful path, so a
 *   successful shutdown cannot be turned into a delayed forced exit and the
 *   timer never keeps the process alive on its own.
 * - `process.exit`/Prisma are injected, so the whole lifecycle is unit-testable.
 */
export function createShutdownHandler(options: ShutdownHandlerOptions): (signal: string) => void {
  const {
    server,
    disconnect,
    logger,
    forceExitMs = 10_000,
    exit = (code: number) => process.exit(code),
    onForceExit,
  } = options;
  let shuttingDown = false;

  return function shutdown(signal: string): void {
    if (shuttingDown) {
      logger.info({ signal }, 'Shutdown already in progress, ignoring signal');
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');

    const forceExitTimer = setTimeout(() => {
      logger.error({ forceExitMs }, 'Forced shutdown after timeout');
      onForceExit?.();
      exit(1);
    }, forceExitMs);
    forceExitTimer.unref?.();

    const finishGracefully = (): void => {
      clearTimeout(forceExitTimer);
      logger.info('Server stopped');
      disconnect()
        .then(() => exit(0))
        .catch((error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.error(
            { name: err.name, message: err.message },
            'Database disconnect failed during shutdown, exiting anyway',
          );
          exit(0);
        });
    };

    if (server) {
      // Stop accepting new connections first, then let in-flight requests drain.
      server.closeIdleConnections?.();
      server.close(() => finishGracefully());
      return;
    }

    finishGracefully();
  };
}

/**
 * CORS origin resolution + the production warning decision, kept pure so it is
 * testable without loading the app or a logger.
 *
 * The `*` fallback is retained for backward compatibility (the PWA and other
 * browser clients rely on it when CORS_ORIGIN is not configured), but running a
 * public API with a wildcard origin in production deserves one loud warning.
 */
export function resolveCorsOrigin(
  nodeEnv: string | undefined,
  corsOrigin: string | undefined,
): { origin: string; warning: string | null } {
  const configured = corsOrigin?.trim();
  if (configured) return { origin: configured, warning: null };

  if (nodeEnv === 'production') {
    return {
      origin: 'https://sl-news.vercel.app',
      warning:
        'CORS_ORIGIN is not set: defaulting to https://sl-news.vercel.app instead of a wildcard. Set CORS_ORIGIN to change it.',
    };
  }
  return { origin: '*', warning: null };
}

/** Process-like target for the signal/fatal handlers (injectable in tests). */
export interface ProcessHandlerTarget {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface ProcessHandlerOptions {
  shutdown: (signal: string) => void;
  logger: ShutdownLogger;
  exit?: (code: number) => void;
  /** Defaults to the real `process`; tests pass an EventEmitter. */
  target?: ProcessHandlerTarget;
}

function fatalErrorContext(reason: unknown): { name: string; message: string; stack?: string } {
  const error = reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'Unknown error');
  return { name: error.name, message: error.message, stack: error.stack };
}

/**
 * Wire SIGTERM/SIGINT to the shutdown handler and make unhandled rejections /
 * uncaught exceptions fatal (log name/message/stack, exit 1) instead of leaving
 * a half-alive process that the platform would keep routing traffic to.
 */
export function installProcessHandlers(options: ProcessHandlerOptions): void {
  const { shutdown, logger, exit = (code: number) => process.exit(code), target = process } = options;

  target.on('SIGTERM', () => shutdown('SIGTERM'));
  target.on('SIGINT', () => shutdown('SIGINT'));
  target.on('unhandledRejection', (reason: unknown) => {
    logger.fatal(fatalErrorContext(reason), 'Unhandled promise rejection — exiting');
    exit(1);
  });
  target.on('uncaughtException', (error: unknown) => {
    logger.fatal(fatalErrorContext(error), 'Uncaught exception — exiting');
    exit(1);
  });
}

const app = express();

app.set('trust proxy', parseTrustProxyHops(process.env.TRUST_PROXY_HOPS));

app.use(helmet());
app.use(compression());

// The `*` fallback is kept for backward compatibility; the production warning
// about it is emitted once by `assertRuntimeEnv` in the startup block below so
// all boot warnings share one log path.
const corsResolution = resolveCorsOrigin(process.env.NODE_ENV, process.env.CORS_ORIGIN);
app.use(
  cors({
    origin: corsResolution.origin,
    // Custom response headers the browser client must be able to read.
    exposedHeaders: ['X-Total-Count', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
  }),
);

// Correlation ids must exist before the logger and before any middleware that
// can throw (body-parser included), so access logs and 4xx/5xx bodies share the
// same id, and every finished response is counted.
app.use(requestIdMiddleware);

app.use(express.json());

if (process.env.NODE_ENV !== 'test') {
  // Every request is logged with its (serialised) headers, so the credentials in
  // them are redacted before the record is written. The access log reuses the
  // correlation id set above instead of pino-http generating its own.
  app.use(
    pinoHttp<express.Request, express.Response>({
      logger,
      redact: LOG_REDACTION,
      genReqId: (req) => req.id,
    }),
  );
}

const limiter = rateLimit({
  windowMs: positiveIntFromEnv(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
  max: positiveIntFromEnv(process.env.RATE_LIMIT_MAX, 100),
  keyGenerator: rateLimitKey,
  // Health/readiness probes must never be throttled: Render probes them every
  // ~10s, and a busy API consumer could otherwise trip the limit and take the
  // health check (and thus the whole service) down with it.
  skip: (req) => {
    const path = req.originalUrl.split('?')[0];
    // `/v1/docs` matches the `/v1` prefix too; it has its own limiter below, so
    // exclude the docs UI from the API budget rather than consuming both.
    const isDocs = path === '/docs' || path.startsWith('/docs/') || path === '/v1/docs' || path.startsWith('/v1/docs/');
    return path === '/api/health' || path === '/api/ready' || isDocs;
  },
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(['/api', '/v1'], limiter);

app.get('/', (_req, res) => {
  res.json({
    name: 'Sierra Leone News API',
    // Describes the credentials accepted by every protected route below.
    auth: describeAuthentication(),
    endpoints: {
      news: '/api/news?limit=20&source=<name>&q=<term>',
      article: '/api/news/:id',
      videos: '/api/videos?limit=20&channel=<name>&q=<term>',
      video: '/api/videos/:id',
      stats: '/api/stats',
      health: '/api/health',
      ready: '/api/ready',
      docs: '/docs',
    },
  });
});

// The interactive docs UI is public and relatively expensive to render, so it
// gets its own conservative limiter (default 300/15min, env-tunable) instead of
// sharing — or bypassing — the API budget. Mounted before swaggerUi.serve/setup.
const docsLimiter = rateLimit({
  windowMs: positiveIntFromEnv(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
  max: positiveIntFromEnv(process.env.DOCS_RATE_LIMIT_MAX, 300),
  keyGenerator: rateLimitKey,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(['/docs', '/v1/docs'], docsLimiter, swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// The readiness probe runs every ~10s. Caching the database probe briefly keeps
// it from multiplying database load, and hides a single transient blip from the
// platform's restart logic. The TTL is zero when NODE_ENV=test so each request
// performs its own probe (tests need deterministic responses).
const HEALTH_CACHE_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 5_000;
let healthProbe: { ok: boolean; checkedAt: number } | undefined;

async function databaseIsReachable(): Promise<boolean> {
  if (healthProbe && healthProbe.checkedAt + HEALTH_CACHE_TTL_MS > Date.now()) {
    return healthProbe.ok;
  }
  const ok = await prisma.$queryRaw`SELECT 1`.then(
    () => true,
    () => false,
  );
  healthProbe = { ok, checkedAt: Date.now() };
  return ok;
}

// Liveness only: answers "is the process up?" and must never touch the database,
// so a database outage cannot make the platform kill a healthy process.
app.get('/api/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    service: 'sl-news-api',
    uptime_seconds: runtimeMetrics().uptime_seconds,
    timestamp: new Date().toISOString(),
  });
});

// Readiness: answers "can this instance serve traffic?" — currently whether the
// cached database probe succeeds. A failure here means the load balancer should
// route around this instance, not restart it.
app.get('/api/ready', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const connected = await databaseIsReachable();
  const timestamp = new Date().toISOString();
  if (connected) {
    res.json({ status: 'ready', database: 'connected', timestamp });
  } else {
    res.status(503).json({ status: 'degraded', database: 'disconnected', timestamp });
  }
});

// Scope enforcement after authentication: the legacy `/api` surface (the
// pinned app's full-text path) needs `internal:read`; the sellable `/v1`
// contracts need `v1:read`. Static/Clerk credentials default to both scopes so
// existing clients are unchanged; DB-backed customer keys get exactly the
// scopes on their row.
app.use('/api/news', requireAuthentication, requireScopes(SCOPES.INTERNAL_READ), newsRouter);
app.use('/api/videos', requireAuthentication, requireScopes(SCOPES.INTERNAL_READ), videosRouter);
app.use('/api/stats', requireAuthentication, requireScopes(SCOPES.INTERNAL_READ), statsRouter);
app.use('/v1/stats', requireAuthentication, requireScopes(SCOPES.V1_READ), statsRouter);

// Versioned business-facing contract: metadata + summary only, for future paying
// customers. The SLNews app is deliberately pinned to the legacy full-text
// /api/news route above and must not be switched to /v1 (it needs `paragraphs`).
app.use('/v1/news', requireAuthentication, requireScopes(SCOPES.V1_READ), v1Router);
app.use('/v1/videos', requireAuthentication, requireScopes(SCOPES.V1_READ), v1VideosRouter);

// JSON 404 for unknown routes (Express's default is an HTML "Cannot GET" page).
// The correlation id lets a caller quote one id when reporting a bad request.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', request_id: req.id });
});

/**
 * Terminal error handler.
 *
 * Honors `err.status`/`err.statusCode` (Express/body-parser set them — a
 * malformed JSON body must be a 400, not a 500) and keeps the JSON error shape.
 * Logging is deliberately narrow: client errors log name/message/status/path,
 * server errors add the stack. The raw error object and the request body are
 * never logged, because body-parser attaches the offending body to its error and
 * that body can contain credentials.
 */
const handleError: express.ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const error: Error = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Unknown error');
  const candidateStatus = typeof err?.status === 'number' ? err.status : err?.statusCode;
  const status =
    typeof candidateStatus === 'number' && candidateStatus >= 400 && candidateStatus <= 599 ? candidateStatus : 500;
  const path = req.originalUrl.split('?')[0];
  const request_id = req.id;

  if (status < 500) {
    logger.warn({ name: error.name, message: error.message, status, path, request_id }, 'Request rejected');
    res.status(status).json({ error: status === 400 ? 'Bad request' : 'Request failed', request_id });
    return;
  }

  logger.error(
    { name: error.name, message: error.message, stack: error.stack, status, path, request_id },
    'Unhandled error',
  );
  res.status(status).json({ error: 'Internal server error', request_id });
};
app.use(handleError);

const PORT = process.env.PORT || 3000;
let server: ReturnType<typeof app.listen> | undefined;

// Tests import the app only: never listen, never install process handlers, never
// call process.exit from a test worker.
if (process.env.NODE_ENV !== 'test') {
  // Fail fast before opening a socket: a broken boot configuration should surface
  // in the deploy logs immediately instead of as per-request 500s. No-ops under
  // NODE_ENV=test, so importing the app in tests is unaffected.
  assertRuntimeEnv();

  server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Sierra Leone News API started');
  });

  const shutdown = createShutdownHandler({
    server,
    disconnect: () => prisma.$disconnect(),
    logger,
  });
  installProcessHandlers({ shutdown, logger });
}

export default app;
