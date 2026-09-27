/**
 * Sign in with Apple token revocation over Apple's REST API (`POST https://appleid.apple.com/auth/revoke`),
 * required by App Store Review Guideline 5.1.1(v) for apps that offer SIWA and account deletion.
 *
 * Apple authenticates the call with a `client_secret` that is itself a short-lived ES256 JWT signed
 * with the team's Sign in with Apple private key (.p8): `iss` = team id, `sub` = client id (the
 * app's bundle id or Services ID), `aud` = https://appleid.apple.com, `kid` header = key id.
 *
 * Status: Studafy does not offer Sign in with Apple yet and stores no Apple tokens
 * (app.oauth_identities deliberately keeps none), so nothing constructs this client today. It is
 * the revocation half the SIWA login ticket plugs in through `SiwaTokenRevocation`
 * (account-deletion-service.ts) once it persists the refresh token Apple returns at sign-in.
 */

import { ERROR_CODES } from "@studafy/constants";
import { importPKCS8, SignJWT } from "jose";

import { CodedHttpException } from "../../coded-http-exception";

export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
const APPLE_AUDIENCE = "https://appleid.apple.com";
/** Apple accepts up to six months; the secret is minted per call, so five minutes is plenty. */
const CLIENT_SECRET_TTL_SECONDS = 5 * 60;

export interface AppleSignInConfig {
  teamId: string;
  clientId: string;
  keyId: string;
  /** The .p8 key contents (PKCS#8 PEM). */
  privateKey: string;
}

export type AppleTokenTypeHint = "refresh_token" | "access_token";

export interface AppleTokenRevoker {
  revoke(token: string, tokenTypeHint: AppleTokenTypeHint): Promise<void>;
}

export async function createAppleClientSecret(
  config: AppleSignInConfig,
  now: Date = new Date(),
): Promise<string> {
  const key = await importPKCS8(config.privateKey, "ES256");
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: config.keyId })
    .setIssuer(config.teamId)
    .setSubject(config.clientId)
    .setAudience(APPLE_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + CLIENT_SECRET_TTL_SECONDS)
    .sign(key);
}

export function createAppleTokenRevoker(
  config: AppleSignInConfig,
  fetchFn: typeof fetch = fetch,
): AppleTokenRevoker {
  return {
    async revoke(token, tokenTypeHint) {
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: await createAppleClientSecret(config),
        token,
        token_type_hint: tokenTypeHint,
      });

      let response: Response;
      try {
        response = await fetchFn(APPLE_REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
      } catch {
        throw revocationFailed("Apple token revocation endpoint could not be reached");
      }

      // Apple answers 200 with an empty body on success; anything else is an `{ error }` body.
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw revocationFailed(
          `Apple token revocation failed with HTTP ${response.status} ${detail}`.trim(),
        );
      }
    },
  };
}

function revocationFailed(message: string): CodedHttpException {
  return new CodedHttpException(502, ERROR_CODES.APPLE_TOKEN_REVOCATION_FAILED, message);
}
