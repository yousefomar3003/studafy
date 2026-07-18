import type { Role } from "@studafy/constants";

/**
 * Custom claims embedded in every access token. These are the application-specific fields
 * beyond the standard JWT registered claims (iss, aud, iat, exp, nbf, jti).
 */
export interface AccessTokenClaims {
  /** Subject — the user's stable UUID. */
  sub: string;
  /** Tenant — the school this token is scoped to. */
  school_id: string;
  /** All roles the user holds in the tenant (from user_roles). */
  roles: Role[];
  /**
   * Monotonically increasing version counter for the user's entitlements. Bumped whenever
   * roles or permissions change, allowing caches to invalidate without token revocation.
   */
  entitlements_ver: number;
  /** Unique token identifier — a v4 UUID, unique across the whole platform. */
  jti: string;
}

/**
 * The full JWT payload. Extends the custom claims with the standard registered claims
 * that `jose` populates automatically or that we set explicitly at signing time.
 */
export interface JwtPayload extends AccessTokenClaims {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  nbf: number;
}

/** Parameters required to mint a new access token. */
export interface SignAccessTokenParams {
  sub: string;
  school_id: string;
  roles: Role[];
  entitlements_ver: number;
}
