import type { NextFunction, Request, Response } from 'express';

/**
 * Scope enforcement for the authenticated API surface.
 *
 * `requireAuthentication` attaches the credential identity/scopes to
 * `req.auth`; `requireScopes(...)` then gates each route mount. Keeping the two
 * concerns separate means the credential type (static key, Clerk JWT, DB key)
 * never leaks into route handlers.
 */

export type AuthScheme = 'static' | 'clerk' | 'api-key';

export interface AuthContext {
  scheme: AuthScheme;
  scopes: string[];
  /** `ApiKey.id` when the credential is a DB-backed customer key. */
  keyId?: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Credential identity/scopes, populated by `requireAuthentication`. */
    auth?: AuthContext;
  }
}

export function hasScope(auth: AuthContext | undefined, scope: string): boolean {
  return auth !== undefined && auth.scopes.includes(scope);
}

/**
 * Middleware factory: requires every given scope. Any missing scope is a 403
 * that names the first missing one in `required_scope`, so a caller can tell
 * exactly what to request instead of guessing.
 */
export function requireScopes(...required: string[]) {
  return function scopeGuard(req: Request, res: Response, next: NextFunction): void {
    const auth = req.auth;
    if (!auth) {
      // Defense in depth: requireAuthentication runs first on every protected
      // mount, so this only triggers on a wiring mistake.
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const missing = required.find((scope) => !auth.scopes.includes(scope));
    if (missing !== undefined) {
      res.status(403).json({
        error: 'Forbidden — credential lacks required scope',
        required_scope: missing,
      });
      return;
    }

    next();
  };
}
