/**
 * Permission-based authorization (ST-072).
 *
 * Authentication and authorization have been separate concerns in this app with only the first one
 * implemented: jwtAuth.ts proves *who* a caller is and hydrates `roles` into the request context,
 * and until now nothing consumed those roles. Every route was therefore deny-by-default at the
 * `/api/*` prefix and allow-all past it. That was survivable while every endpoint operated on the
 * caller's own data; the admin device routes are the first that operate on someone else's, so the
 * missing half has to exist.
 *
 * The policy itself is not defined here. `ROLE_PERMISSIONS` in @studafy/constants is the single
 * source of truth — docs/permission-matrix.md is generated from it, and ADR 0002 fixes the role set
 * — so this module is only the enforcement point. Nothing below decides what a role may do; it
 * decides where the answer is checked.
 */

import { ROLE_PERMISSIONS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { requireAuth } from "./authContext";

import type { AppEnv } from "./requestId";
import type { Permission, Role } from "@studafy/constants";
import type { Context, MiddlewareHandler } from "hono";

/**
 * The permission matrix, keyed for lookup, resolved once at module load.
 *
 * A Map rather than an index into ROLE_PERMISSIONS, for the reason logger.ts records about
 * LEVEL_THRESHOLDS: a computed member access trips eslint-plugin-security's detect-object-injection,
 * and this module takes no disables. That rule is worth heeding here rather than silencing —
 * `role` reaches this function from a JWT claim, and while verify.ts validates it against the ROLES
 * enum before it ever gets here, an authorization check is the last place to rely on a guarantee
 * established three modules away. A Map lookup cannot walk a prototype chain no matter what it is
 * handed.
 *
 * A Set per role rather than the array: membership is what every caller asks, and this turns it from
 * a linear scan of up to ~60 permissions into a hash probe on the hot path of every admin request.
 */
const PERMISSIONS_BY_ROLE: ReadonlyMap<Role, ReadonlySet<Permission>> = new Map(
  Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => [
    role as Role,
    new Set(permissions),
  ]),
);

/**
 * Whether any of a caller's roles grants a permission.
 *
 * Roles are additive: a user holding several gets the union of their permissions, which is what
 * makes an ORG_ADMIN who also teaches a course able to do both jobs from one token. Exported so
 * handlers needing a conditional branch — rather than a hard gate — can ask the same question the
 * middleware does, instead of reimplementing the lookup against the matrix.
 */
export function hasPermission(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((role) => PERMISSIONS_BY_ROLE.get(role)?.has(permission) === true);
}

/**
 * Refuse the request unless the caller holds `permission`.
 *
 * Runs after jwtAuth.ts has established identity — it reads the context that middleware populates —
 * so it must be mounted on a path already inside the `/api/*` authentication boundary. On a route
 * that boundary exempts it would reject every request, since there would be no auth context to read.
 *
 * Both failures are thrown as HTTPException rather than returned, so they travel through
 * errorHandlerMiddleware and pick up the same `application/problem+json` envelope, `code`, and
 * `request_id` correlation as every other error in the app. A hand-built body here would be the one
 * response in the system a client had to special-case.
 */
export function requirePermission(permission: Permission): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // Throws 401 when unauthenticated, which is the correct precedence: "we do not know who you are"
    // has to outrank "you may not do that", or an anonymous caller could distinguish a permission
    // they lack from one they hold by reading the status code.
    const auth = requireAuth(c);

    if (!hasPermission(auth.roles, permission)) {
      // The log carries the detail; the response does not. Naming the missing permission back to the
      // caller would let anyone map the permission matrix by probing endpoints, and a client that
      // legitimately lacks it can do nothing differently with the name anyway.
      c.get("log").warn(
        {
          event: "authorization_denied",
          required_permission: permission,
          actor_roles: auth.roles,
        },
        "caller lacks the permission required for this route",
      );

      throw new HTTPException(403, { message: "Insufficient permissions for this operation" });
    }

    await next();
  };
}

/**
 * Assert a permission from inside a handler.
 *
 * The middleware form is preferred and covers the ordinary case. This exists for handlers whose
 * required permission depends on the request — revoking your own session versus someone else's is
 * the same route with two different answers — where the check cannot be hoisted to mount time.
 */
export function requirePermissionIn(c: Context<AppEnv>, permission: Permission): void {
  const auth = requireAuth(c);
  if (!hasPermission(auth.roles, permission)) {
    throw new HTTPException(403, { message: "Insufficient permissions for this operation" });
  }
}
