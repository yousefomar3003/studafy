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

/** Take the state and accept it only as an authorization this provider's callback may redeem. */
export async function takeAuthorization(
  ctx: CallbackContext,
  state: string,
): Promise<AuthorizationEntry> {
  const entry = await ctx.stateStore.take(state);
  if (!entry || !isAuthorizationEntry(entry) || entry.provider !== ctx.provider) {
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
  let code: ErrorCode;
  if (error instanceof CodedHttpException) code = error.code;
  else if (error instanceof HTTPException) code = ERROR_CODES.OAUTH_PROVIDER_ERROR;
  else throw error;

  if (entry && isMobileFlow(entry.flow)) return appErrorRedirect(c, code);
  return c.redirect(oauthErrorUrl(ctx.frontendUrl ?? "/", code), 302);
}
