import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import logger from '../logger.js';
import {
  describeVerificationFailure,
  isClerkConfigured,
  verifySessionToken,
  type SessionTokenVerifier,
} from './clerk.js';

const STATIC_KEY_MESSAGE = 'Unauthorized — provide a valid API key via Authorization: Bearer <key>';
const STATIC_KEY_OR_CLERK_MESSAGE =
  'Unauthorized — provide a valid API key or Clerk session token via Authorization: Bearer <token>';

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Scheme is case-insensitive per RFC 7235: accept "Bearer", "bearer", etc. */
function extractBearerToken(authorization: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  return match?.[1] ?? '';
}

/** Inside a mounted router `req.path` is relative, so log the full request path. */
function requestPath(req: Request): string {
  return req.originalUrl.split('?')[0];
}

/**
 * Authentication is additive and backward compatible:
 *
 * 1. `Authorization: Bearer <API_KEY>` (what the SLNews app/PWA sends today) is
 *    always accepted, timing-safe.
 * 2. Otherwise, when Clerk is configured, the bearer value is treated as a
 *    Clerk session JWT and verified with Clerk's SDK.
 *
 * With no `CLERK_SECRET_KEY` this behaves exactly like the previous
 * `requireApiKey`, including the 500 misconfiguration path when `API_KEY` is
 * missing too. `verify` is injectable so tests can stub Clerk without I/O.
 */
export function createRequireAuthentication(verify: SessionTokenVerifier = verifySessionToken) {
  return async function requireAuthentication(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Read per request: the platform injects env at boot and tests flip it
    // between requests, so a module-level snapshot would be wrong (and stale).
    const staticKey = process.env.API_KEY;
    const clerkConfigured = isClerkConfigured();

    if (!staticKey && !clerkConfigured) {
      logger.error('API_KEY not configured on server and Clerk is not configured');
      res.status(500).json({ error: 'Server misconfiguration: API_KEY is not set' });
      return;
    }

    const token = extractBearerToken(req.headers.authorization);

    // 1. Static API key — the PWA's path, unchanged and timing-safe.
    if (token && staticKey && timingSafeEqualStr(token, staticKey)) {
      logger.debug({ scheme: 'static', path: requestPath(req) }, 'Request authenticated');
      next();
      return;
    }

    // 2. Clerk session JWT, only when Clerk is configured.
    if (token && clerkConfigured) {
      try {
        const claims = await verify(token);
        logger.info({ scheme: 'clerk', sub: claims.sub, path: requestPath(req) }, 'Request authenticated');
        next();
        return;
      } catch (error) {
        // One warn per rejected Clerk token, carrying only a stable reason code
        // so operators can tell a bad token from a Clerk outage/kid mismatch.
        // The token and Clerk's free-text message never reach the log, and the
        // caller only sees the generic 401.
        logger.warn(
          { path: requestPath(req), reason: describeVerificationFailure(error) },
          'Clerk session token rejected',
        );
        res.status(401).json({ error: STATIC_KEY_OR_CLERK_MESSAGE });
        return;
      }
    }

    // Missing credentials or a bad static key: debug-level only, matching the
    // (silent) pre-Clerk behaviour so scanners cannot flood the logs.
    logger.debug(
      { path: requestPath(req), credentials: token ? 'invalid-static-key' : 'missing' },
      'Unauthorized request',
    );
    res.status(401).json({ error: clerkConfigured ? STATIC_KEY_OR_CLERK_MESSAGE : STATIC_KEY_MESSAGE });
  };
}

export const requireAuthentication = createRequireAuthentication();

/** Human-readable summary of the accepted credentials, for `GET /`. */
export function describeAuthentication(): string {
  const staticKeyConfigured = Boolean(process.env.API_KEY);
  const clerkConfigured = isClerkConfigured();

  if (staticKeyConfigured && clerkConfigured) {
    return 'Requires Authorization: Bearer <key> — a static API key or a Clerk session JWT';
  }
  if (clerkConfigured) return 'Requires Authorization: Bearer <Clerk session JWT>';
  if (staticKeyConfigured) return 'Requires Authorization: Bearer <key>';
  return 'API key not configured on server';
}
