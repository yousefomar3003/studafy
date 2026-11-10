import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../coded-http-exception";

import type { AppEnv } from "./requestId";
import type { MiddlewareHandler } from "hono";

/**
 * The only requests a session may make before its user accepts the current legal documents: read
 * the profile (which says what to accept), record the acceptance, manage the account's own deletion
 * (someone who does not accept must still be able to leave), change their own password (keeping
 * their sign-in secure never waits on paperwork), and sign out. Method + exact path;
 * refresh and login are public and never reach this guard with an auth context.
 */
const ALLOWED_WHILE_PENDING: ReadonlySet<string> = new Set([
  "GET /api/account/profile",
  "POST /api/account/legal-acceptance",
  "POST /api/account/deletion",
  "DELETE /api/account/deletion",
  "POST /api/auth/password/change",
  "POST /api/auth/logout",
]);

/**
 * Legal acceptance guard (000187).
 *
 * A session whose user has not accepted the current Terms of Service and Privacy Policy carries the
 * `legal_acceptance_pending` claim (set when the token is minted), and this guard confines it to
 * {@link ALLOWED_WHILE_PENDING}. The web and mobile apps show the acceptance screen in its place.
 * Reads only the claim (zero DB calls per request); accepting updates the user row and the client
 * refreshes to get a token without the claim.
 *
 * Must be registered AFTER `jwtAuthMiddleware`. Passes through when there is no auth context.
 */
export function legalAcceptanceGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (
      auth?.legalAcceptancePending &&
      !ALLOWED_WHILE_PENDING.has(`${c.req.method} ${c.req.path}`)
    ) {
      throw new CodedHttpException(
        403,
        ERROR_CODES.LEGAL_ACCEPTANCE_REQUIRED,
        "Accept the Terms of Service and the Privacy Policy to continue.",
      );
    }
    await next();
  };
}
