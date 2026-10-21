import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    /** Correlation id assigned by `requestIdMiddleware` (also sent as X-Request-Id). */
    id: string;
  }
}

/** Response header that carries the request correlation id. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Accepted caller-supplied request ids. Anything shorter, longer, or containing
 * characters that could break log lines / upstream tooling is replaced with a
 * server-generated UUID, so an untrusted caller cannot inject content into the
 * logs or trace backends through this header.
 */
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Parse a positive integer from the environment, falling back when the value is
 * missing, non-numeric, or out of range. Shared by the server and route config.
 */
export function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

interface StatusCounters {
  '2xx': number;
  '3xx': number;
  '4xx': number;
  '5xx': number;
}

interface RequestCounters {
  total: number;
  byStatus: StatusCounters;
}

// Process-lifetime counters. They intentionally reset on restart and describe
// only the current process (Render replaces the process on every deploy/restart).
const counters: RequestCounters = {
  total: 0,
  byStatus: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
};

function recordFinishedRequest(statusCode: number): void {
  counters.total += 1;
  if (statusCode >= 200 && statusCode < 300) counters.byStatus['2xx'] += 1;
  else if (statusCode >= 300 && statusCode < 400) counters.byStatus['3xx'] += 1;
  else if (statusCode >= 400 && statusCode < 500) counters.byStatus['4xx'] += 1;
  else if (statusCode >= 500 && statusCode < 600) counters.byStatus['5xx'] += 1;
}

/**
 * Request correlation id + request counters.
 *
 * Must be mounted before `pino-http` (so access logs carry the same id) and
 * before middleware that can throw (so 4xx/5xx bodies can echo the id). A valid
 * inbound `X-Request-Id` is preserved so ids propagate across services; anything
 * else gets a fresh UUID.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get(REQUEST_ID_HEADER);
  const id = incoming !== undefined && VALID_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
  req.id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  res.on('finish', () => recordFinishedRequest(res.statusCode));
  next();
}

export interface RuntimeMetrics {
  uptime_seconds: number;
  process_started_at: string;
  memory_rss_mb: number;
  node_version: string;
  requests_total: number;
  requests_by_status: StatusCounters;
}

const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();
const BYTES_PER_MB = 1024 * 1024;

/** Snapshot of process/runtime + request-count metrics. */
export function runtimeMetrics(): RuntimeMetrics {
  return {
    uptime_seconds: Math.round(process.uptime()),
    process_started_at: PROCESS_STARTED_AT,
    memory_rss_mb: Math.round(process.memoryUsage().rss / BYTES_PER_MB),
    node_version: process.version,
    requests_total: counters.total,
    requests_by_status: { ...counters.byStatus },
  };
}

/** Zero the request counters. Intended for tests; a restart does the same thing. */
export function resetMetrics(): void {
  counters.total = 0;
  counters.byStatus['2xx'] = 0;
  counters.byStatus['3xx'] = 0;
  counters.byStatus['4xx'] = 0;
  counters.byStatus['5xx'] = 0;
}
