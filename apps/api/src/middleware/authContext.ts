import { HTTPException } from "hono/http-exception";

import type { AppEnv } from "./requestId";
import type { AuthChannel } from "../modules/auth/channels";
import type { Role, SubscriptionStatus } from "@studafy/constants";
import type { Context } from "hono";

/**
 * The authenticated session, hydrated from a verified access token by jwtAuth.ts.
 *
 * Every field is non-nullable, and that is the point rather than an accident. `schoolId` in
 * particular is the tenant-isolation pre-flight the whole data layer rests on: src/db/tenant-tx.ts
 * feeds it to the `app.school_id` GUC, and every RLS policy created by
 * db/migrations/000006_create_rls_helper.sql compares rows against that GUC with no `missing_ok`,
 * so it fails closed. Handlers therefore never need a null check, and cross-tenant leakage is
 * prevented at the request entryway instead of at each query.
 *
 * The shape mirrors the 3NF identity schema in
 * db/migrations/000007_create_users_and_identity_tables.sql: `userId`/`schoolId` are the `uuid`
 * primary keys of `app.users`/`app.schools`, and `roles` are `app.user_role` enum values (validated
 * against ROLES, which carries the same values, in modules/auth/jwt/verify.ts).
 */
export interface AuthContext {
  /** `app.users.id` — the token's `sub` claim. */
  userId: string;
  /** `app.users.school_id` — the tenant every downstream query is scoped to. */
  schoolId: string;
  /** Every role the user holds in this tenant. Never empty. */
  roles: readonly Role[];
  /** The client surface this session was established from. */
  channel: AuthChannel;
  /** The token's unique id, used for revocation. See modules/auth/denylist.ts. */
  jti: string;
  /** Entitlement version counter, for cache invalidation without revocation. */
  entitlementsVer: number;
  /** The tenant's current subscription lifecycle state. Drives tenantLifecycleGuard middleware. */
  subscriptionStatus: SubscriptionStatus;
}

/**
 * Read the authenticated session, or reject.
 *
 * Handlers on routes behind jwtAuthMiddleware can use this instead of `c.get("auth")!` to get a
 * non-optional value without an assertion. The throw is a genuine guard, not ceremony: it is what
 * a route mounted outside the protected prefix by mistake would hit, and a 401 is a far better
 * outcome there than a handler reading `undefined.schoolId`.
 */
export function requireAuth(c: Context<AppEnv>): AuthContext {
  const auth = c.get("auth");
  if (!auth) {
    throw new HTTPException(401, { message: "Authentication required" });
  }
  return auth;
}
