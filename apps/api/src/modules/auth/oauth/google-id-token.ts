/**
 * Google ID token validation.
 *
 * Verifies a Google-issued OIDC id_token against Google's published JWKS, the expected issuer,
 * audience, nonce, and email_verified claim. Uses jose's createRemoteJWKSet, which handles key
 * fetching, caching, and rotation automatically.
 *
 * The jwksUri parameter is injectable for testing — production uses Google's real endpoint,
 * tests point at a local mock that serves a generated key pair.
 */

import { ERROR_CODES } from "@studafy/constants";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { CodedHttpException } from "../../../coded-http-exception";

import { GOOGLE_ID_TOKEN_ISSUER, GOOGLE_JWKS_URI } from "./config";

import type { JWTPayload } from "jose";

export interface GoogleIdTokenClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | undefined;
  picture: string | undefined;
}

interface GoogleIdTokenPayload extends JWTPayload {
  email?: string;
  email_verified?: boolean;
  nonce?: string;
  name?: string;
  picture?: string;
}

/**
 * Validate a Google-issued id_token.
 *
 * Checks in order: signature (via Google JWKS), issuer, audience, nonce, email_verified.
 * Each failure throws a CodedHttpException with a client-safe error code.
 */
export async function validateGoogleIdToken(
  idToken: string,
  clientId: string,
  expectedNonce: string,
  jwksUri: string = GOOGLE_JWKS_URI,
): Promise<GoogleIdTokenClaims> {
  const remoteJwks = createRemoteJWKSet(new URL(jwksUri));

  let result;
  try {
    result = await jwtVerify(idToken, remoteJwks, {
      issuer: GOOGLE_ID_TOKEN_ISSUER,
      audience: clientId,
    });
  } catch {
    throw new CodedHttpException(
      401,
      ERROR_CODES.AUTH_TOKEN_INVALID,
      "Invalid Google identity token",
    );
  }

  const payload = result.payload as GoogleIdTokenPayload;

  if (payload.nonce !== expectedNonce) {
    throw new CodedHttpException(400, ERROR_CODES.OAUTH_STATE_INVALID, "Token nonce mismatch");
  }

  if (payload.email_verified !== true) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.OAUTH_EMAIL_NOT_VERIFIED,
      "Google email is not verified",
    );
  }

  if (!payload.sub || !payload.email) {
    throw new CodedHttpException(
      401,
      ERROR_CODES.AUTH_TOKEN_INVALID,
      "Google token missing required claims",
    );
  }

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified,
    name: payload.name,
    picture: payload.picture,
  };
}
