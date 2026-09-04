/**
 * Mock IdP token validation — dev and E2E only.
 *
 * Mirrors google-id-token.ts's shape, adapted to two real differences in what `dev/mock-idp.ts`
 * issues (see that file):
 *
 *   - Its `/token` response has no `id_token` field; the `access_token` it returns *is* the signed
 *     JWT carrying the claims (mock-route.ts reads `access_token` accordingly).
 *   - It signs `aud: <issuer>`, not a per-client id (it has no client registry), so audience is
 *     checked against the issuer rather than a `clientId` parameter — and it never sets
 *     `email_verified`, so unlike Google/Microsoft that claim is not required here.
 *
 * `sub` doubles as `email`: every mock persona's OAuth subject *is* its email
 * (`db/seeds/mock-credentials.ts`'s `mockSubject`), so there is no separate email claim to read.
 */

import { ERROR_CODES } from "@studafy/constants";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { CodedHttpException } from "../../../coded-http-exception";

import type { JWTPayload } from "jose";

export interface MockIdTokenClaims {
  sub: string;
  email: string;
}

interface MockTokenPayload extends JWTPayload {
  nonce?: string;
}

/**
 * Validate a mock-IdP-issued access token.
 *
 * Checks in order: signature (via the mock IdP's own JWKS), issuer, audience, nonce, presence of
 * `sub`. Each failure throws a CodedHttpException with a client-safe error code, matching
 * validateGoogleIdToken's contract so the callers that use both interchangeably see one shape.
 */
export async function validateMockIdToken(
  accessToken: string,
  issuer: string,
  expectedNonce: string,
  jwksUri: string,
): Promise<MockIdTokenClaims> {
  const remoteJwks = createRemoteJWKSet(new URL(jwksUri));

  let result;
  try {
    result = await jwtVerify(accessToken, remoteJwks, {
      issuer,
      audience: issuer,
    });
  } catch {
    throw new CodedHttpException(
      401,
      ERROR_CODES.AUTH_TOKEN_INVALID,
      "Invalid mock identity token",
    );
  }

  const payload = result.payload as MockTokenPayload;

  if (payload.nonce !== expectedNonce) {
    throw new CodedHttpException(400, ERROR_CODES.OAUTH_STATE_INVALID, "Token nonce mismatch");
  }

  if (!payload.sub) {
    throw new CodedHttpException(
      401,
      ERROR_CODES.AUTH_TOKEN_INVALID,
      "Mock token missing required claims",
    );
  }

  return { sub: payload.sub, email: payload.sub };
}
