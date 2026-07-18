import { createLocalJWKSet, jwtVerify } from "jose";

import type { KeyStore } from "./key-store";
import type { JwtPayload } from "./types";

export class TokenVerificationError extends Error {
  constructor(reason: string) {
    super(`Token verification failed: ${reason}`);
    this.name = "TokenVerificationError";
  }
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
}

/**
 * Verify an RS256 access token against the KeyStore's JWKS and return the validated
 * payload. Throws {@link TokenVerificationError} for any malformed, mis-signed,
 * expired, or otherwise invalid token.
 *
 * This function rebuilds a local JWKS from the KeyStore on every call. In practice
 * the overhead is negligible (2 keys max) and it guarantees consistency with whatever
 * keys are currently live after a rotation.
 */
export async function verifyAccessToken(
  keyStore: KeyStore,
  token: string,
  options: VerifyOptions,
): Promise<JwtPayload> {
  const { keys } = await keyStore.toJwks();
  if (keys.length === 0) {
    throw new TokenVerificationError("no keys available");
  }

  const jwks = createLocalJWKSet({ keys });

  let result;
  try {
    result = await jwtVerify(token, jwks, {
      issuer: options.issuer,
      audience: options.audience,
    });
  } catch (err) {
    if (err instanceof Error) {
      throw new TokenVerificationError(err.message);
    }
    throw new TokenVerificationError("unknown verification error");
  }

  const payload = result.payload as unknown as JwtPayload;

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new TokenVerificationError("missing or empty sub claim");
  }
  if (typeof payload.school_id !== "string" || payload.school_id.length === 0) {
    throw new TokenVerificationError("missing or empty school_id claim");
  }
  if (!Array.isArray(payload.roles)) {
    throw new TokenVerificationError("roles claim must be an array");
  }
  if (typeof payload.entitlements_ver !== "number") {
    throw new TokenVerificationError("missing or invalid entitlements_ver claim");
  }
  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    throw new TokenVerificationError("missing or empty jti claim");
  }

  return payload;
}
