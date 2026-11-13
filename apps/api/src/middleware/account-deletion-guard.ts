import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../coded-http-exception";

import type { AppEnv } from "./requestId";
import type { MiddlewareHandler } from "hono";

/**
 * The only requests a session with a scheduled deletion may make (000143's grace period): read
 * the profile (which carries the due date), cancel the deletion, and sign out. Method + exact
 * path; refresh and login are public and never reach this guard with an auth context.
 */
const ALLOWED_WHILE_PENDING: ReadonlySet<string> = new Set([
  "GET /api/account/profile",
  "DELETE /api/account/deletion",
  "POST /api/auth/logout",
]);

/**
 * Account deletion guard.
 *
 * Scheduling a deletion revokes every session; signing in again during the 14-day grace period
 * mints a token carrying the `deletion_pending` claim, and this guard confines that session to
 * {@link ALLOWED_WHILE_PENDING} so the person can see the date and cancel — nothing else. Reads
 * only the claim (zero DB calls per request); cancelling clears the column and the client
 * refreshes to get a token without it.
 *
 * Must be registered AFTER `jwtAuthMiddleware`. Passes through when there is no auth context.
 */
export function accountDeletionGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (auth?.deletionPending && !ALLOWED_WHILE_PENDING.has(`${c.req.method} ${c.req.path}`)) {
      throw new CodedHttpException(
        403,
        ERROR_CODES.ACCOUNT_DELETION_SCHEDULED,
        "This account is scheduled for deletion. Cancel the deletion to continue.",
      );
    }
    await next();
  };
}
