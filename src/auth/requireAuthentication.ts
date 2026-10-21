import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import logger from '../logger.js';
import { API_KEY_PREFIX, parseScopes, SCOPES, verifyApiKey } from './apiKeys.js';
import type { AuthContext } from './authorize.js';
import {
  describeVerificationFailure,
  isClerkConfigured,
  verifySessionToken,
  type SessionTokenVerifier,
} from './clerk.js';

const STATIC_KEY_MESSAGE = 'Unauthorized — provide a valid API key via Authorization: Bearer <key>';
const STATIC_KEY_OR_CLERK_MESSAGE =
  'Unauthorized — provide a valid API key or Clerk session token via Authorization: Bearer <token>';

/**
 * Default scopes for the two legacy credential types. They keep the historical
 * blanket access (`internal:read,v1:read`) so the pinned app and any existing
 * Clerk integration are unchanged; deployments can narrow them with
 * STATIC_KEY_SCOPES / CLERK_SCOPES (recommended once the app has its own
 * internal-only key).
 */
const DEFAULT_SCOPES = `${SCOPES.INTERNAL_READ},${SCOPES.V1_READ}`;

/** Scopes granted to the static `API_KEY`, from env or both by default. */
export function staticKeyScopes(): string[] {
  const configured = parseScopes(process.env.STATIC_KEY_SCOPES);
  return configured.length > 0 ? configured : parseScopes(DEFAULT_SCOPES);
}

/** Scopes granted to verified Clerk session JWTs, from env or both by default. */
export function clerkScopes(): string[] {
  const configured = parseScopes(process.env.CLERK_SCOPES);
  return configured.length > 0 ? configured : parseScopes(DEFAULT_SCOPES);
}

/**
 * Timing-safe credential comparison.
 *
 * Both inputs are hashed to a fixed 32-byte SHA-256 digest before comparing, so
 * `crypto.timingSafeEqual` never sees buffers of different lengths. That matters
 * because it throws on a length mismatch: comparing a multibyte token whose
 * UTF-8 byte length differs from the API key's would otherwise surface as a 500
 * instead of a 401 (and leak the key's byte length to the caller). Hashing the
 * inputs keeps the comparison constant-time while removing that asymmetry.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
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

/** Attach the credential identity/scopes for `requireScopes` downstream. */
function attach(req: Request, auth: AuthContext): void {
  req.auth = auth;
}

/**
 * Authentication is additive and backward compatible:
 *
 * 1. `Authorization: Bearer <API_KEY>` (what the SLNews app/PWA sends today) is
 *    always accepted, timing-safe, with `STATIC_KEY_SCOPES` (default: both).
 * 2. When Clerk is configured, a non-customer-key bearer value is treated as a
 *    Clerk session JWT and verified with Clerk's SDK (`CLERK_SCOPES`, default:
 *    both).
 * 3. A token carrying the `slk_` prefix is treated as a DB-backed customer API
 *    key, which gets exactly the scopes stored on its row. Only these tokens
 *    hit the database (foreign tokens are rejected without a DB round-trip).
 *
 * DB failures during (3) are a 503, never an "invalid key": a database outage
 * must not masquerade as a revoked credential. With no `CLERK_SECRET_KEY` this
 * behaves exactly like the previous `requireApiKey`, including the 500
 * misconfiguration path when `API_KEY` is missing too. `verify` is injectable
 * so tests can stub Clerk without I/O.
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
      const scopes = staticKeyScopes();
      attach(req, { scheme: 'static', scopes });
      logger.debug({ scheme: 'static', scopes, path: requestPath(req) }, 'Request authenticated');
      next();
      return;
    }

    // 2. DB-backed customer key. The `slk_` prefix makes this a cheap, exact
    //    classification: only our generated keys can ever be tried against the
    //    database, so invalid/foreign tokens never amplify into DB load.
    if (token && token.startsWith(API_KEY_PREFIX)) {
      try {
        const verified = await verifyApiKey(token);
        if (verified) {
          attach(req, { scheme: 'api-key', scopes: verified.scopes, keyId: verified.id });
          logger.info(
            { scheme: 'api-key', keyId: verified.id, scopes: verified.scopes, path: requestPath(req) },
            'Request authenticated',
          );
          next();
          return;
        }
      } catch {
        // Never log the raw key: the error/log line carries only the path.
        logger.error({ path: requestPath(req) }, 'API key verification failed');
        res.status(503).json({ error: 'Authentication temporarily unavailable' });
        return;
      }

      // An `slk_` token is never a Clerk JWT, so an unknown customer key is a
      // definitive 401 — do not spend a Clerk verification (and a warn log) on it.
      logger.debug({ path: requestPath(req), credentials: 'invalid-api-key' }, 'Unauthorized request');
      res.status(401).json({ error: clerkConfigured ? STATIC_KEY_OR_CLERK_MESSAGE : STATIC_KEY_MESSAGE });
      return;
    }

    // 3. Clerk session JWT, only when Clerk is configured.
    if (token && clerkConfigured) {
      try {
        const claims = await verify(token);
        const scopes = clerkScopes();
        attach(req, { scheme: 'clerk', scopes });
        logger.info({ scheme: 'clerk', sub: claims.sub, scopes, path: requestPath(req) }, 'Request authenticated');
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

    // Missing credentials or a bad/unknown credential: debug-level only,
    // matching the (silent) pre-Clerk behaviour so scanners cannot flood the
    // logs.
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
    return 'Requires Authorization: Bearer <token> — a static API key, a Clerk session JWT, or a customer API key';
  }
  if (clerkConfigured) return 'Requires Authorization: Bearer <token> — a Clerk session JWT or a customer API key';
  if (staticKeyConfigured) return 'Requires Authorization: Bearer <token> — a static API key or a customer API key';
  return 'API key not configured on server';
}
