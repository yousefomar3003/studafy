/**
 * Browser binding for the browser OAuth flows (QA-20 / F-07: OAuth login CSRF).
 *
 * The `state` parameter alone does not stop login CSRF. An attacker can start a flow in their own
 * browser, sign in to the provider as themselves, stop before their browser follows the redirect
 * back, and send the resulting `…/callback?code=…&state=…` URL to a victim. The state is genuine —
 * this server minted it — so without anything else the victim's browser would finish the attacker's
 * flow: a session for the attacker's account (login), an invitation activated with the attacker's
 * identity, or the attacker's provider linked to the victim's account (link).
 *
 * So every browser flow also binds the state to the browser that started it:
 *
 *   - **start** sets an HttpOnly cookie holding a random secret and stores only its SHA-256 in the
 *     state entry (`browserBinding`);
 *   - **callback** accepts the state only when the request carries that cookie and its hash matches
 *     the entry. The attacker's state is bound to the attacker's browser; the victim's browser
 *     cannot present the attacker's cookie, so the callback refuses it before the code is exchanged.
 *
 * The secret is per browser, not per flow: a start reuses a well-formed cookie already present, so
 * two flows running in two tabs of the same browser both still complete. It is short-lived (the
 * state TTL), refreshed on every start, and worthless on its own — it unlocks nothing but a state
 * this browser itself minted.
 *
 * Cookie attributes:
 *   - `SameSite=Lax` — the callback is a top-level GET navigation *from the provider's site*. Strict
 *     would withhold the cookie on exactly that request; Lax sends it on top-level GETs and nowhere
 *     else cross-site.
 *   - `Path=/api/auth/oauth` — every callback (login, and the school-application one) lives under it,
 *     so the cookie is sent there and on no other API request.
 *   - `HttpOnly`, and `Secure` everywhere except development and test (no TLS there).
 *
 * The native-app flows (`mobile-login`, `mobile-activation`) are not bound here: their start is a
 * JSON call from the app, not the browser that reaches the callback, and they are already bound to
 * the app by the nonce the handoff requires (mobile-handoff.ts).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { getCookie, setCookie } from "hono/cookie";

import { getSecurityConfig } from "../../../config/security";

import { OAUTH_STATE_TTL_MS } from "./state-store";

import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

export const OAUTH_BINDING_COOKIE_NAME = "studafy_oauth_binding";
export const OAUTH_BINDING_COOKIE_PATH = "/api/auth/oauth";

/** 32 bytes of CSPRNG, base64url without padding. */
const BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Bind the flow being started to this browser: set (or refresh) the binding cookie and return the
 * hash to store on the state entry as `browserBinding`.
 */
export function bindBrowser(c: Context<AppEnv>): string {
  const existing = getCookie(c, OAUTH_BINDING_COOKIE_NAME);
  const secret =
    existing !== undefined && BINDING_PATTERN.test(existing)
      ? existing
      : randomBytes(32).toString("base64url");

  setCookie(c, OAUTH_BINDING_COOKIE_NAME, secret, {
    httpOnly: true,
    secure: useSecureCookie(),
    sameSite: "Lax",
    path: OAUTH_BINDING_COOKIE_PATH,
    maxAge: Math.ceil(OAUTH_STATE_TTL_MS / 1000),
  });
  return hashBinding(secret);
}

/**
 * Whether the callback request comes from the browser the flow was bound to. False when the entry
 * carries no binding, the cookie is missing or malformed, or the two do not match.
 */
export function isBoundBrowser(c: Context<AppEnv>, expected: string | undefined): boolean {
  if (!expected) return false;
  const secret = getCookie(c, OAUTH_BINDING_COOKIE_NAME);
  if (secret === undefined || !BINDING_PATTERN.test(secret)) return false;

  const presented = Buffer.from(hashBinding(secret), "utf8");
  const stored = Buffer.from(expected, "utf8");
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

function hashBinding(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("base64url");
}

function useSecureCookie(): boolean {
  const { environment } = getSecurityConfig();
  return environment !== "development" && environment !== "test";
}
