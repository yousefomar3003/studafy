/**
 * PKCE, state, and nonce generation for OAuth authorization-code flow.
 *
 * All functions are pure — no I/O, no side effects, no external dependencies beyond node:crypto.
 * Every output is base64url-encoded (RFC 4648 §5) without padding, which is what Google's
 * authorization endpoint expects for code_challenge and the wire format for state/nonce.
 */

import { createHash, randomBytes } from "node:crypto";

/**
 * Generate a PKCE code_verifier (RFC 7636 §4.1).
 *
 * 32 bytes of CSPRNG, base64url-encoded → 43 characters. The spec requires 43–128 characters
 * from [A-Za-z0-9-._~]; base64url satisfies that range.
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Derive a PKCE code_challenge from a verifier (RFC 7636 §4.2).
 *
 * SHA-256 of the verifier, base64url-encoded → 43 characters. The S256 method is mandatory for
 * public clients; plain is deliberately omitted.
 */
export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * Generate an OAuth state parameter.
 *
 * 32 bytes of CSPRNG → 64-character hex string. The state binds the callback to the start request
 * and prevents CSRF on the authorization endpoint.
 */
export function generateState(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Generate an OIDC nonce.
 *
 * 32 bytes of CSPRNG → 64-character hex string. The nonce is included in the authorization
 * request and embedded in the id_token by Google. The callback verifies the two match to prevent
 * token replay.
 */
export function generateNonce(): string {
  return randomBytes(32).toString("hex");
}
