import { ROLES, SUBSCRIPTION_STATUSES } from "@studafy/constants";

import { CodedHttpException } from "../coded-http-exception";

import type { AppEnv } from "./requestId";
import type { Role, SubscriptionStatus } from "@studafy/constants";
import type { MiddlewareHandler } from "hono";

/**
 * Roles allowed read-only access during tenant suspension.
 *
 * ORG_ADMIN and FINANCE are the only roles that need billing recovery and data inspection
 * during suspension. All other roles are completely blocked.
 */
const SUSPENDED_READ_ROLES: ReadonlySet<Role> = new Set<Role>([ROLES.ORG_ADMIN, ROLES.FINANCE]);

/**
 * Tenant lifecycle guard middleware (ST-092).
 *
 * Enforces the subscription lifecycle state machine on every authenticated `/api/*` request.
 * Reads the `subscriptionStatus` claim from the JWT (zero DB calls per request) and applies
 * the appropriate access rules:
 *
 * - **closed**: All requests blocked (403 Forbidden).
 * - **suspended**: Write operations blocked. GET allowed only for ORG_ADMIN and FINANCE.
 * - **grace_period**: Full access with `X-Tenant-Grace-Banner: true` response header.
 * - **trialing / active / past_due / canceled / expired**: Standard access.
 *
 * Passes through silently on unauthenticated requests (no auth context), allowing public
 * routes within `/api/*` to function normally.
 *
 * Must be registered AFTER `jwtAuthMiddleware` so that `c.get("auth")` is populated.
 *
 * @example
 * ```typescript
 * app.use("/api/*", tenantLifecycleGuard());
 * ```
 */
export function tenantLifecycleGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth) {
      await next();
      return;
    }

    const status = auth.subscriptionStatus;

    switch (status) {
      // ── Terminal lockout ──────────────────────────────────────────────
      case SUBSCRIPTION_STATUSES.CLOSED:
        throw new CodedHttpException(
          403,
          "TENANT_CLOSED" as never,
          "This tenant has been permanently closed. Contact support for assistance.",
        );

      // ── Suspension: read-only for billing roles ──────────────────────
      case "suspended" as SubscriptionStatus: {
        const method = c.req.method;

        // All writes are blocked regardless of role.
        if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
          throw new CodedHttpException(
            403,
            "TENANT_SUSPENDED" as never,
            "Tenant is suspended. Only read access is available for billing recovery.",
          );
        }

        // GET/HEAD/OPTIONS: only ORG_ADMIN and FINANCE may read.
        const hasReadRole = auth.roles.some((role) => SUSPENDED_READ_ROLES.has(role));
        if (!hasReadRole) {
          throw new CodedHttpException(
            403,
            "TENANT_SUSPENDED" as never,
            "Tenant is suspended. Contact your administrator for access.",
          );
        }

        await next();
        return;
      }

      // ── Grace period: full access + banner flag ──────────────────────
      case SUBSCRIPTION_STATUSES.GRACE_PERIOD:
        await next();
        c.header("X-Tenant-Grace-Banner", "true");
        return;

      // ── Normal states: trialing, active, past_due, canceled, expired ─
      default:
        await next();
        return;
    }
  };
}
