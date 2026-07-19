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
}

/**
 * Mint a signed RS256 access token. The token carries the application claims (sub,
 * school_id, roles, entitlements_ver, channel, jti) plus the standard registered claims
 * (iss, aud, iat, exp, nbf).
 *
 * The `jti` is a v4 UUID generated per call — callers do not supply it.
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
    .setJti(randomUUID())
    .sign(key.privateKey);

  return token;
}
