import { randomUUID } from "node:crypto";

import { SignJWT } from "jose";

import type { KeyStore } from "./key-store";
import type { SignAccessTokenParams } from "./types";

export interface SignOptions {
  /** JWT issuer claim. */
  issuer: string;
  /** JWT audience claim. */
  audience: string;
  /** Token lifetime in seconds. */
  ttlSeconds: number;
  /**
   * The `jti` to stamp on the token. Generated per call when omitted.
   *
   * Supplied by the session service (ST-072), which has to persist the value on the
   * `app.refresh_tokens` row in the same statement that creates the session — revocation later reads
   * it back to denylist the token. Letting the caller pass a jti it already holds is what makes that
   * possible without this function returning one, which would change the shape of every call site
   * for the benefit of two.
   *
   * Callers that supply one own its uniqueness. It must be a v4 UUID: verify.ts validates the claim
   * with `pgUuidSchema`, and the denylist keys on it.
   */
  jti?: string;
}

/**
 * Mint a signed RS256 access token. The token carries the application claims (sub,
 * school_id, roles, entitlements_ver, channel, jti) plus the standard registered claims
 * (iss, aud, iat, exp, nbf).
 *
 * The `jti` is a v4 UUID generated per call unless the caller supplies one.
 */
export async function signAccessToken(
  keyStore: KeyStore,
  params: SignAccessTokenParams,
  options: SignOptions,
): Promise<string> {
  const key = keyStore.signingKey();
  const now = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({
    school_id: params.school_id,
    roles: params.roles,
    entitlements_ver: params.entitlements_ver,
    channel: params.channel,
  })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setSubject(params.sub)
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setIssuedAt(now)
    .setExpirationTime(`${options.ttlSeconds}s`)
    .setNotBefore(now)
    .setJti(options.jti ?? randomUUID())
    .sign(key.privateKey);

  return token;
}
