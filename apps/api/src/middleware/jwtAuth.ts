import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { TokenVerificationError, verifyAccessToken } from "../modules/auth/jwt/verify";

import type { AuthContext } from "./authContext";
import type { AppEnv } from "./requestId";
import type { JtiDenylist } from "../modules/auth/denylist";
import type { KeyStore } from "../modules/auth/jwt/key-store";
import type { TokenFailureReason } from "../modules/auth/jwt/verify";
import type { ErrorCode } from "@studafy/constants";
import type { MiddlewareHandler } from "hono";

/**
 * JWT verification middleware — the authentication boundary for protected routes.
 *
 * Verifies an RS256 bearer token against the local key store, checks it has not been revoked, and
 * hydrates `c.set("auth", …)` with a fully validated session. Nothing downstream ever sees an
 * unauthenticated request or a partially trusted claim.
 *
 * @example
 * ```typescript
 * app.use("/api/*", jwtAuthMiddleware({ keyStore, denylist, issuer, audience }));
 * ```
 */

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface JwtAuthOptions {
  /** Key store holding the live signing/verification keys. */
  keyStore: KeyStore;
  /**
   * Revocation denylist. `null` disables the revocation check — acceptable only where Redis is
   * genuinely absent (local development without a Redis instance), and logged as a warning on
   * every request so it cannot pass unnoticed in a deployed environment.
   */
  denylist: JtiDenylist | null;
  /** Required `iss` claim. Threaded from env.JWT_ISSUER. */
  issuer: string;
  /** Required `aud` claim. Threaded from env.JWT_AUDIENCE. */
  audience: string;
  /**
   * Path prefixes below the mount point that skip authentication entirely.
   *
   * Defaults to the webhook prefix, which authenticates by HMAC signature rather than by session
   * token (see src/erpnext/webhook.ts), plus the two session-lifecycle endpoints that authenticate
   * with a refresh token instead (see modules/auth/routes/session-routes.ts). Kept as an explicit
   * list rather than an opt-in flag on each route so that the set of unauthenticated endpoints is
   * enumerable in one place.
   */
  publicPaths?: string[];
}

/**
 * Every endpoint under /api that does not authenticate with a bearer access token.
 *
 * `/api/auth/refresh` and `/api/auth/logout` are here because a client reaches them precisely when
 * its access token is expired or gone — requiring one would make them unreachable exactly when they
 * are needed. Their credential is the refresh token, verified against app.refresh_tokens by the
 * session service, so they are not unauthenticated so much as authenticated by other means.
 *
 * Note these are exact paths, not prefixes like /api/webhooks: the rest of /api/auth (session
 * enumeration and termination) must stay behind the boundary, and a `/api/auth` prefix would open
 * all of it. isPublicPath below matches accordingly.
 */
const DEFAULT_PUBLIC_PATHS = [
  "/api/webhooks",
  "/api/auth/refresh",
  "/api/auth/logout",
  "/api/auth/oauth",
  "/api/auth/login",
];

function isInvitationSubPath(path: string, action: "verify" | "activate"): boolean {
  const segments = path.split("/");
  return (
    segments.length === 6 &&
    segments[0] === "" &&
    segments[1] === "api" &&
    segments[2] === "auth" &&
    segments[3] === "invitations" &&
    segments[4] !== "" &&
    segments[5] === action
  );
}

function isInvitationVerificationPath(path: string): boolean {
  return isInvitationSubPath(path, "verify");
}

// Account activation (ST-078) authenticates with the invitation token in the path plus a verified
// Microsoft OIDC identity in the body, not a bearer session — so, like verification, it is exempt
// from the JWT boundary. The exemption is scoped to exactly `.../invitations/{token}/activate`; the
// rest of /api/auth stays protected.
function isInvitationActivationPath(path: string): boolean {
  return isInvitationSubPath(path, "activate");
}

// ---------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------

/**
 * Map a verification failure onto a client-facing error code.
 *
 * Only expiry is distinguished, and that is intentional. An expired token is an ordinary,
 * non-adversarial event — the client's correct response is to refresh, and telling it so avoids a
 * pointless retry loop. Everything else collapses to AUTH_TOKEN_INVALID: separating "bad signature"
 * from "unknown kid" from "malformed claims" in the response would tell an attacker which part of
 * a forged token to fix next. The precise reason is still recorded server-side, in the log line.
 */
const FAILURE_CODES: Record<TokenFailureReason, ErrorCode> = {
  malformed: ERROR_CODES.AUTH_TOKEN_INVALID,
  key: ERROR_CODES.AUTH_TOKEN_INVALID,
  signature: ERROR_CODES.AUTH_TOKEN_INVALID,
  expired: ERROR_CODES.AUTH_TOKEN_EXPIRED,
  claims: ERROR_CODES.AUTH_TOKEN_INVALID,
  no_keys: ERROR_CODES.INTERNAL_ERROR,
};

/**
 * A 401 that carries the specific error code rather than letting the status decide it.
 *
 * errorHandlerMiddleware derives a code from the HTTP status by default, which would flatten every
 * authentication failure to AUTH_TOKEN_INVALID. This subclass lets the handler recover the code we
 * actually determined; see the `AuthException` branch in errorHandler.ts.
 */
export class AuthException extends HTTPException {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(401, { message });
    this.name = "AuthException";
  }
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Build the JWT verification middleware.
 *
 * The order of operations inside is the performance strategy, not just control flow. Each step is
 * cheaper than the one after it, and every rejection returns before the next step runs:
 *
 * 1. Path exemption — a string comparison.
 * 2. Header parse — no crypto, no I/O. Catches the entire class of unauthenticated requests.
 * 3. Signature, `exp`, `iss`/`aud`, and claim shape — one RSA verification against the key the
 *    token's own `kid` resolves to. This dominates the measured cost of the whole middleware.
 * 4. Revocation lookup — a single Redis `EXISTS`, and the only network hop in the path.
 *
 * Step 4 running last is the part that matters most: a tampered or expired token is rejected
 * without ever touching Redis, so a flood of garbage tokens costs no cache I/O at all. Inverting
 * 3 and 4 would put a network round-trip in front of every forged request.
 * tests/auth/short-circuit.test.ts holds this ordering by counting denylist lookups — a status
 * code alone cannot tell the two arrangements apart.
 */
/**
 * Whether a path is exempt from authentication.
 *
 * An entry matches the path exactly, or as a path-segment prefix — never as a bare string prefix.
 * The difference is load-bearing now that the list holds exact endpoints as well as trees:
 * `"/api/auth/refresh"` must not exempt `/api/auth/refresh-everything`, and a plain `startsWith`
 * would. Segment-aware matching keeps `/api/webhooks` covering `/api/webhooks/erpnext` while making
 * an entry incapable of opening a sibling route that merely shares its opening characters.
 */
function isPublicPath(path: string, publicPaths: readonly string[]): boolean {
  return (
    isInvitationVerificationPath(path) ||
    isInvitationActivationPath(path) ||
    publicPaths.some((entry) => path === entry || path.startsWith(`${entry}/`))
  );
}

export function jwtAuthMiddleware({
  keyStore,
  denylist,
  issuer,
  audience,
  publicPaths = DEFAULT_PUBLIC_PATHS,
}: JwtAuthOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isPublicPath(c.req.path, publicPaths)) {
      await next();
      return;
    }

    const log = c.get("log");

    // --- 1. Bearer header ---------------------------------------------------
    const header = c.req.header("Authorization");
    if (!header) {
      log?.warn({ reason: "missing_header" }, "authentication failed");
      throw new AuthException(ERROR_CODES.AUTH_TOKEN_INVALID, "Missing bearer token");
    }

    // Scheme match is case-insensitive: RFC 7235 defines the auth-scheme token as case-insensitive,
    // and real clients do send "bearer".
    const [scheme, ...rest] = header.split(" ");
    const token = rest.join(" ").trim();
    if (scheme?.toLowerCase() !== "bearer" || token.length === 0) {
      log?.warn({ reason: "malformed_header" }, "authentication failed");
      throw new AuthException(ERROR_CODES.AUTH_TOKEN_INVALID, "Malformed Authorization header");
    }

    // --- 2. Cryptographic verification (before any I/O) ---------------------
    let payload;
    try {
      payload = await verifyAccessToken(keyStore, token, { issuer, audience });
    } catch (err) {
      const failure: TokenFailureReason =
        err instanceof TokenVerificationError ? err.failure : "signature";

      // An empty key store is our fault, not the caller's, and answering 401 would send clients
      // into a refresh loop against a server that cannot verify anything.
      if (failure === "no_keys") {
        log?.error({ err }, "authentication failed: key store empty");
        throw new HTTPException(503, { message: "Authentication temporarily unavailable" });
      }

      // The token itself is never logged, in any form. It is a live credential until it expires,
      // and log sinks are a wider audience than the request path it arrived on.
      log?.warn({ reason: failure }, "authentication failed");
      throw new AuthException(FAILURE_CODES[failure], "Invalid authentication token");
    }

    // --- 3. Revocation ------------------------------------------------------
    if (denylist) {
      let revoked: boolean;
      try {
        revoked = await denylist.isRevoked(payload.jti);
      } catch (err) {
        // Fail closed. See the rationale on createJtiDenylist: unlike the rate limiter, letting
        // traffic through here would silently resurrect every logged-out session.
        log?.error({ err }, "denylist lookup failed");
        throw new HTTPException(503, { message: "Authentication temporarily unavailable" });
      }

      if (revoked) {
        log?.warn({ reason: "revoked" }, "authentication failed");
        throw new AuthException(ERROR_CODES.AUTH_TOKEN_INVALID, "Token has been revoked");
      }
    } else {
      log?.warn("jti denylist unavailable — token revocation is not enforced");
    }

    // --- 4. Hydrate context -------------------------------------------------
    const auth: AuthContext = {
      userId: payload.sub,
      schoolId: payload.school_id,
      roles: payload.roles,
      channel: payload.channel,
      jti: payload.jti,
      entitlementsVer: payload.entitlements_ver,
    };
    c.set("auth", auth);

    // Re-child the logger with the identity we just established. This is the seam described in
    // docs/architecture/SAD_28_logging_conventions.md: requestIdMiddleware binds school_id/user_id
    // as null on the way in because no identity exists yet, and this line rebinds them. The keys
    // are duplicated in the serialized output by design — last one wins.
    if (log) {
      c.set("log", log.child({ school_id: auth.schoolId, user_id: auth.userId }));
    }

    await next();
  };
}
