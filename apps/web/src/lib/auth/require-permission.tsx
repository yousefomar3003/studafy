import { useEffect, type PropsWithChildren } from "react";
import { useNavigate } from "react-router-dom";

import { usePermissions } from "./context";

import type { Permission } from "@studafy/constants";

export interface RequirePermissionProps extends PropsWithChildren {
  permission: Permission;
  /**
   * Where a session lacking the permission is sent. Defaults to the portal home — the one
   * destination every authenticated role can reach (see `role-home.ts`).
   */
  fallback?: string;
}

/**
 * Route guard for a single permission-gated page, nested inside `RequireAuth` (it reads
 * `usePermissions()`, which needs an authenticated session to mean anything). Unlike `RequireAuth`,
 * which reacts to a session status the store resolves asynchronously, the permission set is already
 * known synchronously once authenticated — so there is no loading state here, only allowed or not.
 *
 * A denied session is redirected with `?notice=forbidden` on the fallback URL, the same
 * query-param-carries-the-reason convention `RequireAuth` already uses for `?reason=expired` on
 * `/auth/login` — one page can render both without a second notification mechanism.
 *
 * This is UX, not the authorization boundary: the permission set is derived from the token's roles
 * client-side (see `permissions.ts`) and the API re-checks independently on every request. Hiding
 * or redirecting away from a page here only avoids showing a route the user could not use.
 */
export function RequirePermission({
  permission,
  fallback = "/portal",
  children,
}: RequirePermissionProps) {
  const permissions = usePermissions();
  const navigate = useNavigate();
  const allowed = permissions.has(permission);

  useEffect(() => {
    if (!allowed) {
      void navigate(`${fallback}?notice=forbidden`, { replace: true });
    }
  }, [allowed, fallback, navigate]);

  return allowed ? <>{children}</> : null;
}
