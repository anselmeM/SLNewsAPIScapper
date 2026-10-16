import { verifyToken } from '@clerk/backend';
import { TokenVerificationErrorReason } from '@clerk/backend/errors';

/**
 * Claims read from a verified Clerk session JWT. `verifyToken` returns Clerk's
 * full JwtPayload; only `sub` (the acting user) is used by the request path —
 * the rest stays available for structured logging without being trusted.
 */
export interface ClerkSessionClaims {
  sub?: string;
  azp?: string;
  [claim: string]: unknown;
}

export type SessionTokenVerifier = (token: string) => Promise<ClerkSessionClaims>;

/** Clerk is optional: the static API_KEY alone keeps working without it. */
export function isClerkConfigured(): boolean {
  return Boolean(process.env.CLERK_SECRET_KEY);
}

/**
 * `CLERK_AUTHORIZED_PARTIES` is a comma-separated allowlist of `azp` values
 * (the origins allowed to hold a session for this instance). Unset or blank
 * means "do not restrict by party", which matches Clerk's own default.
 */
export function parseAuthorizedParties(raw: string | undefined): string[] | undefined {
  const parties = (raw ?? '')
    .split(',')
    .map((party) => party.trim())
    .filter(Boolean);
  return parties.length > 0 ? parties : undefined;
}

/**
 * Verifies a Clerk session JWT with Clerk's own SDK, so JWKS fetching and
 * caching stay the SDK's job. Kept as a single small function so the
 * middleware can take a stub instead (see `createRequireAuthentication`) and
 * tests never touch the network.
 */
export const verifySessionToken: SessionTokenVerifier = async (token) => {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is not configured');

  const authorizedParties = parseAuthorizedParties(process.env.CLERK_AUTHORIZED_PARTIES);
  const claims = await verifyToken(token, {
    secretKey,
    ...(authorizedParties ? { authorizedParties } : {}),
  });

  return claims as ClerkSessionClaims;
};

/**
 * Stable, non-secret reason code for the server log. The token itself and
 * Clerk's free-text message are never logged or returned to the caller, and
 * only codes Clerk defines are ever emitted, so no attacker-influenced text can
 * reach the log either.
 *
 * `instanceof TokenVerificationError` cannot be used here: Clerk's bundled
 * `@clerk/backend` entry inlines its own copy of that class, which is a
 * different class object from the one `@clerk/backend/errors` exports, so the
 * check never matches an error thrown by `verifyToken` (verified against the
 * real SDK: a malformed token yields `reason: 'token-invalid'`). Match on the
 * `reason` string instead.
 */
const KNOWN_REASONS: ReadonlySet<string> = new Set(Object.values(TokenVerificationErrorReason));

export function describeVerificationFailure(error: unknown): string {
  const reason = (error as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === 'string' && KNOWN_REASONS.has(reason) ? reason : 'verification-failed';
}
