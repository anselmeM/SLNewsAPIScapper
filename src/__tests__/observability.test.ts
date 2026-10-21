import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER, requestIdMiddleware, resetMetrics, runtimeMetrics } from '../observability.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type FakeResponse = EventEmitter & {
  statusCode: number;
  setHeader(name: string, value: string): void;
};

function fakeRequest(incomingId?: string): Request {
  const headers: Record<string, string> = {};
  if (incomingId !== undefined) headers['x-request-id'] = incomingId;
  return {
    headers,
    get(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

function fakeResponse(): { res: FakeResponse; headers: Record<string, string>; finish(statusCode?: number): void } {
  const headers: Record<string, string> = {};
  const res = new EventEmitter() as FakeResponse;
  res.statusCode = 200;
  res.setHeader = (name: string, value: string) => {
    headers[name.toLowerCase()] = value;
  };
  const finish = (statusCode = 200) => {
    res.statusCode = statusCode;
    res.emit('finish');
  };
  return { res, headers, finish };
}

function runMiddleware(req: Request, res: FakeResponse, next: NextFunction): void {
  requestIdMiddleware(req, res as unknown as Response, next);
}

beforeEach(() => {
  resetMetrics();
});

describe('requestIdMiddleware', () => {
  it('generates a UUID and echoes it in the X-Request-Id header', () => {
    const req = fakeRequest();
    const { res, headers } = fakeResponse();
    const next = vi.fn();

    runMiddleware(req, res, next);

    expect(req.id).toMatch(UUID_RE);
    expect(headers[REQUEST_ID_HEADER.toLowerCase()]).toBe(req.id);
    expect(next).toHaveBeenCalledOnce();
  });

  it('preserves a syntactically valid inbound X-Request-Id (case-insensitive header lookup)', () => {
    const inbound = 'client-request_01.abc';
    const req = fakeRequest(inbound);
    const { res, headers } = fakeResponse();

    runMiddleware(req, res, vi.fn());

    expect(req.id).toBe(inbound);
    expect(headers['x-request-id']).toBe(inbound);
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(129)],
    ['contains a space', 'not a valid id'],
    ['contains invalid punctuation', 'abc12345!forged'],
    ['contains newlines (log injection)', 'abc12345\nforged: yes'],
  ])('replaces an invalid inbound id (%s)', (_label, inbound) => {
    const req = fakeRequest(inbound);
    const { res, headers } = fakeResponse();

    runMiddleware(req, res, vi.fn());

    expect(req.id).not.toBe(inbound);
    expect(req.id).toMatch(UUID_RE);
    expect(headers['x-request-id']).toBe(req.id);
  });

  it('counts finished requests by status class', () => {
    const next = vi.fn();
    for (const statusCode of [200, 204, 301, 304, 400, 404, 429, 500, 503]) {
      const { res, finish } = fakeResponse();
      runMiddleware(fakeRequest(), res, next);
      finish(statusCode);
    }

    const metrics = runtimeMetrics();
    expect(metrics.requests_total).toBe(9);
    expect(metrics.requests_by_status).toEqual({ '2xx': 2, '3xx': 2, '4xx': 3, '5xx': 2 });
  });

  it('does not count a request until the response finishes', () => {
    const { res } = fakeResponse();
    runMiddleware(fakeRequest(), res, vi.fn());

    expect(runtimeMetrics().requests_total).toBe(0);
  });
});

describe('runtimeMetrics', () => {
  it('reports process/runtime fields and zeroed counters after reset', () => {
    const metrics = runtimeMetrics();

    expect(metrics.uptime_seconds).toEqual(expect.any(Number));
    expect(metrics.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(metrics.process_started_at))).toBe(false);
    expect(metrics.memory_rss_mb).toEqual(expect.any(Number));
    expect(metrics.memory_rss_mb).toBeGreaterThan(0);
    expect(metrics.node_version).toBe(process.version);
    expect(metrics.requests_total).toBe(0);
    expect(metrics.requests_by_status).toEqual({ '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 });
  });

  it('zeroes counters via resetMetrics()', () => {
    const { res, finish } = fakeResponse();
    runMiddleware(fakeRequest(), res, vi.fn());
    finish(500);
    expect(runtimeMetrics().requests_total).toBe(1);

    resetMetrics();

    expect(runtimeMetrics().requests_total).toBe(0);
    expect(runtimeMetrics().requests_by_status).toEqual({ '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 });
  });
});
