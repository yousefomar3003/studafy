/**
 * Handing a provider-verified identity from the browser callback to the native app.
 *
 * A native app cannot use the providers' web clients with its own custom-scheme redirect (Google
 * refuses non-HTTPS redirect URIs on a web client, and the code exchange must repeat whatever
 * redirect URI the code was issued for). So the app's sign-in goes through this API the same way
 * the browser flows do:
 *
 *   1. `/mobile-start` mints the authorization state (`flow: "mobile-login"` or `"mobile-activation"`).
 *   2. The app opens `/api/auth/oauth/{provider}/mobile-authorize`, which redirects to the provider
 *      with the server's registered client and redirect URI.
 *   3. The provider returns to the server's callback, which exchanges the code and verifies the
 *      id_token exactly as for a browser login, then calls {@link handOffToApp}: the verified
 *      identity is stored under a fresh one-time code, and the browser is sent to the app's deep
 *      link with that code and the original state.
 *   4. The app posts code + state + nonce to its `/mobile-exchange` endpoint, which redeems the
 *      handoff ({@link redeemHandoff}) and signs the user in on the mobile channel.
 */

import { MOBILE_OAUTH_REDIRECT_URI } from "./mobile-redirect";
import { generateState } from "./pkce";
import { takeStateFor } from "./state-store";

import type {
  AuthorizationEntry,
  HandoffEntry,
  OAuthStateProvider,
  StateStore,
} from "./state-store";
import type { AppEnv } from "../../../middleware/requestId";
import type { ErrorCode } from "@studafy/constants";
import type { Context } from "hono";

/** Store the verified identity under a one-time code and send the browser to the app's deep link. */
export async function handOffToApp(
  c: Context<AppEnv>,
  store: StateStore,
  entry: AuthorizationEntry,
  state: string,
  identity: { sub: string; email: string },
): Promise<Response> {
  const code = generateState();
  await store.set(code, {
    flow: "mobile-handoff",
    provider: entry.provider,
    purpose: entry.flow === "mobile-activation" ? "activation" : "login",
    state,
    nonce: entry.nonce,
    identity: { sub: identity.sub, email: identity.email },
    token: entry.token,
  });

  const target = new URL(MOBILE_OAUTH_REDIRECT_URI);
  target.searchParams.set("code", code);
  target.searchParams.set("state", state);
  return c.redirect(target.toString(), 302);
}

/** Send a failed mobile sign-in back to the app, which closes its sign-in sheet on `error`. */
export function appErrorRedirect(c: Context<AppEnv>, errorCode: ErrorCode): Response {
  const target = new URL(MOBILE_OAUTH_REDIRECT_URI);
  target.searchParams.set("error", errorCode);
  return c.redirect(target.toString(), 302);
}

/**
 * Redeem a handoff: the code must exist, belong to this provider and purpose, and answer the same
 * state and nonce the app was given at `/mobile-start`. Single use — a mismatch still consumes it.
 */
export async function redeemHandoff(
  store: StateStore,
  input: {
    code: string;
    state: string;
    nonce: string;
    provider: OAuthStateProvider;
    purpose: HandoffEntry["purpose"];
  },
): Promise<HandoffEntry | undefined> {
  const handoff = await takeStateFor(store, input.code, "mobile-handoff", input.provider);
  if (
    !handoff ||
    handoff.purpose !== input.purpose ||
    handoff.state !== input.state ||
    handoff.nonce !== input.nonce
  ) {
    return undefined;
  }
  return handoff;
}
