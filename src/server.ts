import 'dotenv/config';
import crypto from 'crypto';
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
import logger, { LOG_REDACTION } from './logger.js';

/**
 * Positive integer read from the environment, falling back when the value is
 * missing, non-numeric, or out of range.
 */
function envPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

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
 * Rate-limit key: the hashed bearer token when the caller authenticates, so
 * each credential gets its own budget (and API keys are never stored or logged
 * raw); otherwise the client IP, normalised through express-rate-limit's
 * `ipKeyGenerator` so IPv6 clients cannot cycle addresses inside their /64 to
 * dodge the limiter.
 */
function rateLimitKey(req: express.Request): string {
  const authorization = req.headers.authorization;
  if (authorization) {
    return crypto.createHash('sha256').update(authorization, 'utf8').digest('hex');
  }
  return ipKeyGenerator(req.ip ?? '');
}

const app = express();

app.set('trust proxy', parseTrustProxyHops(process.env.TRUST_PROXY_HOPS));

app.use(helmet());
app.use(compression());

const allowedOrigin = process.env.CORS_ORIGIN || '*';
app.use(
  cors({
    origin: allowedOrigin,
    // Custom response headers the browser client must be able to read.
    exposedHeaders: ['X-Total-Count', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
  }),
);

app.use(express.json());

if (process.env.NODE_ENV !== 'test') {
  // Every request is logged with its (serialised) headers, so the credentials in
  // them are redacted before the record is written.
  app.use(pinoHttp({ logger, redact: LOG_REDACTION }));
}

const limiter = rateLimit({
  windowMs: envPositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
  max: envPositiveInt(process.env.RATE_LIMIT_MAX, 100),
  keyGenerator: rateLimitKey,
  // Health checks must never be throttled: Render probes /api/health every
  // ~10s, and a busy API consumer could otherwise trip the limit and take the
  // health check (and thus the whole service) down with it.
  skip: (req) => req.originalUrl.split('?')[0] === '/api/health',
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
      docs: '/docs',
    },
  });
});

app.use(['/docs', '/v1/docs'], swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Health probes run every ~10s. Caching the database probe briefly keeps the
// health check from multiplying database load, and hides a single transient
// blip from the platform's restart logic. The TTL is zero when NODE_ENV=test so
// each request performs its own probe (tests need deterministic responses).
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

app.get('/api/health', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const connected = await databaseIsReachable();
  const timestamp = new Date().toISOString();
  if (connected) {
    res.json({ status: 'ok', database: 'connected', timestamp });
  } else {
    res.status(503).json({ status: 'degraded', database: 'disconnected', timestamp });
  }
});

app.use('/api/news', requireAuthentication, newsRouter);
app.use('/api/videos', requireAuthentication, videosRouter);
app.use(['/api/stats', '/v1/stats'], requireAuthentication, statsRouter);

// Versioned business-facing contract: metadata + summary only, for future paying
// customers. The SLNews app is deliberately pinned to the legacy full-text
// /api/news route above and must not be switched to /v1 (it needs `paragraphs`).
app.use('/v1/news', requireAuthentication, v1Router);
app.use('/v1/videos', requireAuthentication, v1VideosRouter);

// JSON 404 for unknown routes (Express's default is an HTML "Cannot GET" page)
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
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

  if (status < 500) {
    logger.warn({ name: error.name, message: error.message, status, path }, 'Request rejected');
    res.status(status).json({ error: status === 400 ? 'Bad request' : 'Request failed' });
    return;
  }

  logger.error({ name: error.name, message: error.message, stack: error.stack, status, path }, 'Unhandled error');
  res.status(status).json({ error: 'Internal server error' });
};
app.use(handleError);

const PORT = process.env.PORT || 3000;
let server: ReturnType<typeof app.listen> | undefined;

if (process.env.NODE_ENV !== 'test') {
  server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Sierra Leone News API started');
  });
}

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down gracefully');
  if (server) {
    server.close(() => {
      prisma.$disconnect().then(() => {
        logger.info('Server stopped');
        process.exit(0);
      });
    });
  } else {
    prisma.$disconnect().then(() => {
      logger.info('Server stopped');
      process.exit(0);
    });
  }
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
