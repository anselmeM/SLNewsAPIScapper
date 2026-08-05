import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import pinoHttp from 'pino-http';
import newsRouter from './routes/news.js';
import { prisma } from './db.js';
import { swaggerSpec } from './config/swagger.js';
import logger from './logger.js';

const app = express();

app.use(helmet());

const allowedOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

app.use(express.json());

if (process.env.NODE_ENV !== 'test') {
  app.use(pinoHttp({ logger }));
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  // Health checks must never be throttled: Render probes /api/health every
  // ~10s, and a busy API consumer could otherwise trip the limit and take the
  // health check (and thus the whole service) down with it.
  skip: (req) => req.originalUrl.split('?')[0] === '/api/health',
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

const API_KEY = process.env.API_KEY;

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!API_KEY) {
    logger.error('API_KEY not configured on server');
    return res.status(500).json({ error: 'Server misconfiguration: API_KEY is not set' });
  }
  // Scheme is case-insensitive per RFC 7235: accept "Bearer", "bearer", etc.
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  const key = match?.[1] ?? '';
  if (key && timingSafeEqualStr(key, API_KEY)) return next();
  res.status(401).json({ error: 'Unauthorized — provide a valid API key via Authorization: Bearer <key>' });
}

app.get('/', (_req, res) => {
  res.json({
    name: 'Sierra Leone News API',
    auth: API_KEY ? 'Requires Authorization: Bearer <key>' : 'API key not configured on server',
    endpoints: {
      news: '/api/news?limit=20&source=<name>',
      article: '/api/news/:id',
      health: '/api/health',
      docs: '/docs',
    },
  });
});

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.get('/api/health', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'disconnected', timestamp: new Date().toISOString() });
  }
});

app.use('/api/news', requireApiKey, newsRouter);

// JSON 404 for unknown routes (Express's default is an HTML "Cannot GET" page)
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(err, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Sierra Leone News API started');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down gracefully');
  server.close(() => {
    prisma.$disconnect().then(() => {
      logger.info('Server stopped');
      process.exit(0);
    });
  });
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
