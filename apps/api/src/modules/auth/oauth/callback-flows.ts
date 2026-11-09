/**
 * The parts of a provider callback that are the same for Google, Microsoft and the mock provider:
 * redeeming the state, finishing every flow other than a browser login, and routing failures back
 * to wherever the flow started (a browser tab, or the native app).
 *
 * Each provider's callback still owns its own code exchange and id_token validation (the providers
 * differ there), and its own browser-login arm.
 */

import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../../coded-http-exception";
import { completeWebActivation } from "../routes/activation-oauth-routes";
import { completeWebLink } from "../routes/provider-link-routes";

import { isBoundBrowser } from "./browser-binding";
import { oauthErrorUrl } from "./error-redirect";
import { appErrorRedirect, handOffToApp } from "./mobile-handoff";
import { isAuthorizationEntry, isMobileFlow } from "./state-store";

import type { AuthorizationEntry, OAuthStateProvider, StateStore } from "./state-store";
import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { SessionTokenConfig } from "../services/session-service";
import type { ErrorCode } from "@studafy/constants";
import type { Context } from "hono";

export interface CallbackContext {
  db: Database;
  sessionConfig: SessionTokenConfig;
  logger: Logger;
  stateStore: StateStore;
  provider: OAuthStateProvider;
  /** FRONTEND_URL, or undefined when unset. */
  frontendUrl: string | undefined;
}

function invalidState(): CodedHttpException {
  return new CodedHttpException(
    400,
    ERROR_CODES.OAUTH_STATE_INVALID,
    "Invalid or expired OAuth state",
  );
}

/**
 * Transitional (QA-20). A browser-flow state minted before browser binding shipped carries no
 * `browserBinding`, so it can never pass the check below. Rather than failing the user who was
 * mid-sign-in during the deploy, the callback discards that state — the code is never exchanged, so
 * nothing is issued from it — and sends the browser back to the same flow's start, which mints a
 * bound state. The new state is bound, so this restarts a flow at most once. Safe to delete once
 * no unbound state can remain: one state TTL (5 minutes) after every instance runs this code.
 */
export class UnboundStateRestart extends Error {
  constructor(readonly location: string) {
    super("OAuth state predates browser binding; restarting the flow");
  }
}

/** Where to restart a pre-binding browser flow, or undefined when it cannot restart on its own. */
function restartLocation(entry: AuthorizationEntry): string | undefined {
  if (entry.flow === "login") return `/api/auth/oauth/${entry.provider}/start`;
  if (entry.flow === "activation" && entry.token) {
    return `/api/auth/invitations/${encodeURIComponent(entry.token)}/oauth/${entry.provider}/start`;
  }
  // `link` needs the user's bearer token to start, which a browser redirect cannot carry.
  return undefined;
}

/**
 * Take the state and accept it only as an authorization this provider's callback may redeem — and,
 * for a browser flow, only in the browser that started it (browser-binding.ts). A state presented
 * from another browser is consumed and refused before the code is exchanged, so no session, link
 * or activation can result from it.
 */
export async function takeAuthorization(
  c: Context<AppEnv>,
  ctx: CallbackContext,
  state: string,
): Promise<AuthorizationEntry> {
  const entry = await ctx.stateStore.take(state);
  if (!entry || !isAuthorizationEntry(entry) || entry.provider !== ctx.provider) {
    throw invalidState();
  }
  if (!isMobileFlow(entry.flow) && entry.browserBinding === undefined) {
    const location = restartLocation(entry);
    if (location) throw new UnboundStateRestart(location);
  }
  if (!isMobileFlow(entry.flow) && !isBoundBrowser(c, entry.browserBinding)) {
    ctx.logger.warn(
      { provider: ctx.provider, flow: entry.flow },
      "OAuth callback without the browser binding of its start",
    );
    throw invalidState();
  }
  return entry;
}

/**
 * The provider reported an error instead of a code — the user declined consent. Nothing is broken,
 * so the flow ends on its friendly "cancelled" state: the native app's deep link for a mobile flow,
 * the frontend's error page otherwise.
 */
export async function cancelledRedirect(
  c: Context<AppEnv>,
  ctx: CallbackContext,
): Promise<Response> {
  const state = c.req.query("state");
  const entry = state ? await ctx.stateStore.take(state) : undefined;
  if (entry && isMobileFlow(entry.flow)) {
    return appErrorRedirect(c, ERROR_CODES.OAUTH_CANCELLED);
  }
  return c.redirect(oauthErrorUrl(ctx.frontendUrl ?? "/", ERROR_CODES.OAUTH_CANCELLED), 302);
}

/**
 * Finish every flow other than a browser login, once the callback has verified the identity.
 * Returns undefined for a `login` entry, which the provider's own callback finishes.
 */
export async function finishFlow(
  c: Context<AppEnv>,
  ctx: CallbackContext,
  entry: AuthorizationEntry,
  state: string,
  identity: { sub: string; email: string },
): Promise<Response | undefined> {
  if (isMobileFlow(entry.flow)) {
    if (entry.flow === "mobile-activation" && !entry.token) throw invalidState();
    return handOffToApp(c, ctx.stateStore, entry, state, identity);
  }
  if (entry.flow === "activation" && entry.token) {
    return completeWebActivation(
      c,
      { db: ctx.db, sessionConfig: ctx.sessionConfig, logger: ctx.logger },
      { provider: ctx.provider, token: entry.token, identity, frontendUrl: ctx.frontendUrl },
    );
  }
  if (entry.flow === "link" && entry.userId && entry.schoolId && ctx.provider !== "mock") {
    return completeWebLink(c, ctx.db, ctx.logger, {
      provider: ctx.provider,
      userId: entry.userId,
      schoolId: entry.schoolId,
      identity,
      frontendUrl: ctx.frontendUrl,
    });
  }
  if (entry.flow !== "login") throw invalidState();
  return undefined;
}

/**
 * Turn a callback failure into a redirect. The user is mid-round-trip in a real browser: an
 * authored failure (bad state, unknown account, …) and an exchange-level failure (unreachable
 * provider) both land somewhere that shows guidance — the native app for a mobile flow, the
 * frontend's error page otherwise — never raw JSON at the API origin. Anything unexpected is
 * rethrown to the global error handler.
 */
export function failureRedirect(
  c: Context<AppEnv>,
  ctx: CallbackContext,
  entry: AuthorizationEntry | undefined,
  error: unknown,
): Response {
  if (error instanceof UnboundStateRestart) return c.redirect(error.location, 302);

  let code: ErrorCode;
  if (error instanceof CodedHttpException) code = error.code;
  else if (error instanceof HTTPException) code = ERROR_CODES.OAUTH_PROVIDER_ERROR;
  else throw error;

  if (entry && isMobileFlow(entry.flow)) return appErrorRedirect(c, code);
  return c.redirect(oauthErrorUrl(ctx.frontendUrl ?? "/", code), 302);
}
