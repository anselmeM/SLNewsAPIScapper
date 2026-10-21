import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import app, { createShutdownHandler, installProcessHandlers, resolveCorsOrigin } from '../server.js';

vi.mock('../db.js', () => {
  const model = () => ({
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    groupBy: vi.fn(),
    count: vi.fn(),
  });

  return {
    prisma: {
      article: model(),
      video: model(),
      apiKey: model(),
      apiKeyUsage: model(),
      $queryRaw: vi.fn(),
      $disconnect: vi.fn(),
    },
  };
});

function createFakeLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
}

function createFakeServer() {
  const state: { closeCallback?: (err?: Error) => void } = {};
  const server = {
    closeIdleConnections: vi.fn(),
    close: vi.fn((callback?: (err?: Error) => void) => {
      state.closeCallback = callback;
    }),
  };
  return { server, state };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createShutdownHandler lifecycle', () => {
  it('drains idle connections, closes the server, disconnects and exits 0, clearing the force-exit timer', async () => {
    vi.useFakeTimers();
    const baselineTimers = vi.getTimerCount();
    const logger = createFakeLogger();
    const exit = vi.fn();
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const { server, state } = createFakeServer();
    const shutdown = createShutdownHandler({ server, disconnect, logger, exit, forceExitMs: 10_000 });

    shutdown('SIGTERM');

    expect(logger.info).toHaveBeenCalledWith({ signal: 'SIGTERM' }, 'Shutting down gracefully');
    expect(server.closeIdleConnections).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    // Nothing is disconnected/exited until the in-flight requests drain.
    expect(disconnect).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(baselineTimers + 1);

    state.closeCallback?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(disconnect).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.info).toHaveBeenCalledWith('Server stopped');
    // The deadline was cleared on the graceful path: no late forced exit, no
    // dangling timer keeping the event loop alive.
    expect(vi.getTimerCount()).toBe(baselineTimers);
  });

  it('force-exits with code 1 when the server never finishes closing', async () => {
    vi.useFakeTimers();
    const logger = createFakeLogger();
    const exit = vi.fn();
    const onForceExit = vi.fn();
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const { server } = createFakeServer();
    server.close.mockImplementation(() => undefined); // never calls back
    const shutdown = createShutdownHandler({
      server,
      disconnect,
      logger,
      exit,
      forceExitMs: 10_000,
      onForceExit,
    });

    shutdown('SIGTERM');
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onForceExit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(disconnect).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith({ forceExitMs: 10_000 }, 'Forced shutdown after timeout');
  });

  it('ignores a second signal while a shutdown is already in flight', async () => {
    vi.useFakeTimers();
    const baselineTimers = vi.getTimerCount();
    const logger = createFakeLogger();
    const exit = vi.fn();
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const { server, state } = createFakeServer();
    const shutdown = createShutdownHandler({ server, disconnect, logger, exit, forceExitMs: 10_000 });

    shutdown('SIGTERM');
    shutdown('SIGTERM');
    shutdown('SIGINT');

    // Only one close/in-flight shutdown and one deadline exist.
    expect(server.closeIdleConnections).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(baselineTimers + 1);
    expect(logger.info).toHaveBeenCalledWith({ signal: 'SIGINT' }, 'Shutdown already in progress, ignoring signal');

    state.closeCallback?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('shuts down cleanly when no server is listening yet', async () => {
    vi.useFakeTimers();
    const baselineTimers = vi.getTimerCount();
    const logger = createFakeLogger();
    const exit = vi.fn();
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const shutdown = createShutdownHandler({ disconnect, logger, exit, forceExitMs: 10_000 });

    shutdown('SIGINT');
    await vi.advanceTimersByTimeAsync(0);

    expect(disconnect).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(baselineTimers);
  });

  it('unrefs the force-exit timer so it cannot keep the process alive by itself', () => {
    const fakeTimer = { unref: vi.fn() };
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockReturnValue(fakeTimer as unknown as ReturnType<typeof setTimeout>);
    try {
      const { server } = createFakeServer();
      server.close.mockImplementation(() => undefined);
      const shutdown = createShutdownHandler({
        server,
        disconnect: vi.fn().mockResolvedValue(undefined),
        logger: createFakeLogger(),
        exit: vi.fn(),
        forceExitMs: 10_000,
      });

      shutdown('SIGTERM');

      expect(fakeTimer.unref).toHaveBeenCalledOnce();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('still exits 0 and logs when the Prisma disconnect fails', async () => {
    vi.useFakeTimers();
    const logger = createFakeLogger();
    const exit = vi.fn();
    const disconnect = vi.fn().mockRejectedValue(new Error('database gone'));
    const { server, state } = createFakeServer();
    const shutdown = createShutdownHandler({ server, disconnect, logger, exit, forceExitMs: 10_000 });

    shutdown('SIGTERM');
    state.closeCallback?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.error).toHaveBeenCalledWith(
      { name: 'Error', message: 'database gone' },
      'Database disconnect failed during shutdown, exiting anyway',
    );
  });
});

describe('installProcessHandlers', () => {
  it('routes SIGTERM/SIGINT to shutdown and makes fatal errors exit 1', () => {
    const target = new EventEmitter();
    const logger = createFakeLogger();
    const exit = vi.fn();
    const shutdown = vi.fn();
    installProcessHandlers({ shutdown, logger, exit, target });

    target.emit('SIGTERM');
    target.emit('SIGINT');
    expect(shutdown.mock.calls).toEqual([['SIGTERM'], ['SIGINT']]);

    const error = new Error('boom');
    error.stack = 'Error: boom\n    at test';
    target.emit('uncaughtException', error);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.fatal).toHaveBeenCalledWith(
      { name: 'Error', message: 'boom', stack: 'Error: boom\n    at test' },
      'Uncaught exception — exiting',
    );

    exit.mockClear();
    logger.fatal.mockClear();
    target.emit('unhandledRejection', 'reason string');
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Error', message: 'reason string' }),
      'Unhandled promise rejection — exiting',
    );
  });
});

describe('resolveCorsOrigin', () => {
  it('falls back to * and warns when CORS_ORIGIN is unset in production', () => {
    expect(resolveCorsOrigin('production', undefined)).toEqual({
      origin: '*',
      warning: expect.stringContaining('CORS_ORIGIN'),
    });
  });

  it('treats a blank CORS_ORIGIN as unset', () => {
    expect(resolveCorsOrigin('production', '   ')).toEqual({
      origin: '*',
      warning: expect.stringContaining('CORS_ORIGIN'),
    });
  });

  it('does not warn outside production and keeps the * fallback', () => {
    expect(resolveCorsOrigin('development', undefined)).toEqual({ origin: '*', warning: null });
    expect(resolveCorsOrigin('test', '')).toEqual({ origin: '*', warning: null });
  });

  it('uses a configured origin without warning', () => {
    expect(resolveCorsOrigin('production', 'https://pwa.example.com')).toEqual({
      origin: 'https://pwa.example.com',
      warning: null,
    });
  });
});

describe('docs rate limiting', () => {
  it('rate-limits the public Swagger UI with its own budget (default 300/15min)', async () => {
    const res = await request(app).get('/docs/');

    expect(res.status).toBeLessThan(400);
    expect(res.headers['ratelimit-limit']).toBe('300');
    expect(res.headers['ratelimit-remaining']).toBeDefined();
  });

  it('covers the /v1/docs alias too', async () => {
    const res = await request(app).get('/v1/docs/');

    expect(res.status).toBeLessThan(400);
    expect(res.headers['ratelimit-limit']).toBeDefined();
  });
});
