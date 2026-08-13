import { ROLES, ROLE_PERMISSIONS } from "@studafy/constants";

import type { Permission, Role } from "@studafy/constants";

/**
 * Derives the union of permissions granted by a session's roles, for UI gating (which nav items,
 * menu entries, and shell affordances render). This mirrors the server's fixed role → permission
 * assignment (`@studafy/constants`, see `docs/adr/0002-fixed-roles-authorization.md`) but is not
 * itself an authorization boundary: the API re-checks every request independently
 * (`requirePermission` in `apps/api/src/middleware/authz.ts`). Hiding a menu item here only avoids
 * showing a route the user could not use; it never substitutes for the server's own check.
 *
 * Unrecognized role strings (a token from a future rollout the client hasn't caught up to) are
 * ignored rather than thrown on, consistent with `decodeAccessTokenRoles`.
 */
const KNOWN_ROLES = new Set<string>(Object.values(ROLES));

function isKnownRole(role: string): role is Role {
  return KNOWN_ROLES.has(role);
}

export function permissionsForRoles(roles: readonly string[]): ReadonlySet<Permission> {
  const permissions = new Set<Permission>();
  for (const role of roles) {
    if (!isKnownRole(role)) {
      continue;
    }
    // eslint-disable-next-line security/detect-object-injection -- `role` is narrowed to `Role` by isKnownRole above, drawn only from the fixed ROLES set, never external input
    for (const permission of ROLE_PERMISSIONS[role]) {
      permissions.add(permission);
    }
  }
  return permissions;
}
