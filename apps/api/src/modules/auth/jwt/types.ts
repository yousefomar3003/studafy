import type { AuthChannel } from "../channels";
import type { Role, SubscriptionStatus } from "@studafy/constants";

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
   * The school's entitlement version at the moment this token was minted (ST-133).
   *
   * A monotonically increasing counter held in `app.entitlement_versions`, bumped whenever the
   * school's subscription state changes. jwtAuthMiddleware rejects a token whose value is below the
   * current one with AUTH_ENTITLEMENTS_STALE, so a subscription change takes effect within seconds
   * instead of waiting out the token's TTL.
   *
   * An absent counter row means version 1, which is also the value every token minted before ST-133
   * carries — so those tokens remain valid until their school's first real subscription change.
   *
   * Scope note: this tracks *subscription* changes only. A role change does not bump it today; that
   * is a known gap, not an implied guarantee.
   */
  entitlements_ver: number;
  /** Unique token identifier — a v4 UUID, unique across the whole platform. */
  jti: string;
  /** The client surface this token was minted for. See ../channels.ts. */
  channel: AuthChannel;
  /** The tenant's current subscription lifecycle state. Drives the lifecycle middleware. */
  subscription_status: SubscriptionStatus;
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
  channel: AuthChannel;
  subscription_status: SubscriptionStatus;
}
