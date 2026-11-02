/**
 * Microsoft identity platform ID token validation.
 *
 * Verifies a Microsoft-issued OIDC id_token against the Microsoft JWKS, validates the issuer
 * using prefix matching (to handle tenant-varied issuers from the common endpoint), checks the
 * audience, nonce, and required claims. Normalizes the preferred_username / email claim to
 * lowercase for consistent oauth_identities lookups.
 *
 * Key differences from Google:
 *   - Issuer is tenant-specific: https://login.microsoftonline.com/{tenant}/v2.0
 *   - Uses prefix matching instead of strict equality to safely accept all Entra ID tenants
 *   - No email_verified check — Entra ID doesn't reliably include this claim; presence of the
 *     email/preferred_username claim implies verification under tenant admin policy
 *   - preferred_username (UPN) is the primary identifier, with email as fallback
 *
 * The jwksUri parameter is injectable for testing — production uses the Microsoft discovery
 * endpoint, tests point at a local mock.
 */

import { ERROR_CODES } from "@studafy/constants";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { CodedHttpException } from "../../../coded-http-exception";

import { MICROSOFT_ISSUER_PREFIX, MICROSOFT_JWKS_URI } from "./microsoft-config";

import type { JWTPayload } from "jose";

export interface MicrosoftIdTokenClaims {
  sub: string;
  email: string;
  name: string | undefined;
  tenantId: string | undefined;
}

interface MicrosoftIdTokenPayload extends JWTPayload {
  preferred_username?: string;
  email?: string;
  nonce?: string;
  name?: string;
  tid?: string;
}

function isMicrosoftIssuer(issuer: string | undefined): boolean {
  if (!issuer) return false;
  if (!issuer.startsWith(MICROSOFT_ISSUER_PREFIX)) return false;
  return issuer.endsWith("/v2.0");
}

function extractTenantId(issuer: string): string | undefined {
  // issuer format: https://login.microsoftonline.com/{tenant}/v2.0
  const prefix = MICROSOFT_ISSUER_PREFIX;
  if (!issuer.startsWith(prefix)) return undefined;
  const afterPrefix = issuer.slice(prefix.length);
  const slashIndex = afterPrefix.indexOf("/");
  if (slashIndex === -1) return undefined;
  return afterPrefix.slice(0, slashIndex);
}

/**
 * Validate a Microsoft identity platform id_token.
 *
 * Checks in order: signature (via Microsoft JWKS), issuer (prefix match), audience, nonce,
 * and required claims. Normalizes the email to lowercase for consistent identity lookups.
 * Each failure throws a CodedHttpException with a client-safe error code.
 */
export async function validateMicrosoftIdToken(
  idToken: string,
  clientId: string,
  expectedNonce: string,
  jwksUri: string = MICROSOFT_JWKS_URI,
): Promise<MicrosoftIdTokenClaims> {
  const remoteJwks = createRemoteJWKSet(new URL(jwksUri));

  // jose's jwtVerify rejects tokens whose `iss` doesn't exactly match the provided issuer.
  // Since Microsoft uses tenant-varied issuers, we cannot pass a static issuer to jwtVerify.
  // Instead we verify signature + audience here, then validate the issuer manually.
  let result;
  try {
    result = await jwtVerify(idToken, remoteJwks, {
      audience: clientId,
    });
  } catch {
    throw new CodedHttpException(
      401,
      ERROR_CODES.AUTH_TOKEN_INVALID,
      "Invalid Microsoft identity token",
    );
  }

  const payload = result.payload as MicrosoftIdTokenPayload;

  // Issuer prefix match — accepts any tenant while rejecting non-Microsoft issuers.
  if (!isMicrosoftIssuer(payload.iss)) {
    throw new CodedHttpException(
      401,
      ERROR_CODES.AUTH_TOKEN_INVALID,
      "Invalid Microsoft token issuer",
    );
  }

  if (payload.nonce !== expectedNonce) {
    throw new CodedHttpException(400, ERROR_CODES.OAUTH_STATE_INVALID, "Token nonce mismatch");
  }

  // Microsoft uses preferred_username (UPN) as the primary email-like identifier.
  // Normalize to lowercase to prevent duplicate identities from case differences.
  const rawEmail = payload.preferred_username ?? payload.email;
  if (!payload.sub || !rawEmail) {
    throw new CodedHttpException(
      401,
      ERROR_CODES.AUTH_TOKEN_INVALID,
      "Microsoft token missing required claims",
    );
  }

  return {
    sub: payload.sub,
    email: rawEmail.toLowerCase(),
    name: payload.name,
    tenantId: extractTenantId(payload.iss ?? ""),
  };
}
