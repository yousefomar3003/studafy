/**
 * Reads the `roles` claim out of an already-issued access token, client-side, for routing UX only
 * (e.g. "which home page does this session land on"). This is never an authorization decision: the
 * token is not re-verified here — it doesn't need to be, because it is the very credential this
 * browser is about to send as its `Authorization: Bearer` header, and the API verifies it
 * independently on every request (`jwtAuthMiddleware`). A forged or stale token simply fails
 * whatever request tries to use it; at worst this module routes to the wrong page.
 *
 * See `docs/security/JWT_verification_architecture.md` for the claim's source of truth (the
 * `app.user_roles` table) and the encoding this decodes.
 */

/** The one claim this module cares about. Every other claim on the token is ignored. */
interface AccessTokenPayload {
  readonly roles?: readonly unknown[];
}

function base64UrlDecode(segment: string): string | null {
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    return globalThis.atob(padded);
  } catch {
    return null;
  }
}

/**
 * Extracts the `roles` claim from a JWT's payload segment. Returns an empty array for a malformed
 * token, a missing/non-array claim, or any decode failure — callers should treat that the same as
 * "no roles known yet" rather than throw, since this only ever feeds a routing default.
 */
export function decodeAccessTokenRoles(accessToken: string): readonly string[] {
  const payloadSegment = accessToken.split(".")[1];
  if (!payloadSegment) {
    return [];
  }

  const json = base64UrlDecode(payloadSegment);
  if (json === null) {
    return [];
  }

  let payload: AccessTokenPayload;
  try {
    payload = JSON.parse(json) as AccessTokenPayload;
  } catch {
    return [];
  }

  if (!Array.isArray(payload.roles)) {
    return [];
  }
  return payload.roles.filter((role): role is string => typeof role === "string");
}
