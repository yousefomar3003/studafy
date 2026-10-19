/**
 * Where a freshly authenticated session lands. Today's only caller is the invitation activation
 * flow (`routes/invite/InviteCompletePage.tsx`), routing a just-activated user home by role.
 *
 * Roles with a home page of their own (platform console, admin, principal, finance) land there; everyone else lands on the generic `/portal`, which also forwards those roles
 * to their home when they click "Home" (see `routes/portal/PortalPage.tsx`). Keeping the map here
 * makes a new per-role destination a one-line edit instead of a hunt through every flow that routes
 * a user home. `ROLE_PRIORITY` decides which destination wins
 * if a session ever carries more than one matching role.
 *
 * Roles are carried as plain strings, not the `@studafy/constants` `Role` union. The web app already
 * treats role values this way at its other boundary (`lib/realtime/protocol.ts`): validating a role
 * is the server's job; the client only needs to route on the value it was handed.
 */
const DEFAULT_HOME = "/portal";

const ROLE_HOME: Readonly<Record<string, string>> = {
  SUPER_ADMIN: "/portal/platform",
  ORG_ADMIN: "/portal/admin",
  PRINCIPAL: "/portal/principal",
  FINANCE: "/portal/finance",
  // Students, parents, teachers and attendance officers are mobile-only (`MOBILE_ONLY_ROLES`) and
  // never get a web session, so they have no entry here.
  GUEST: "/portal",
};

/** Most- to least-privileged, matching `ROLE_HOME`'s keys. Only used to break ties on multi-role sessions. */
const ROLE_PRIORITY: readonly string[] = [
  "SUPER_ADMIN",
  "ORG_ADMIN",
  "PRINCIPAL",
  "FINANCE",
  "GUEST",
];

/** Resolves the home route for a session holding the given roles. Falls back to `/portal`. */
export function resolveRoleHome(roles: readonly string[]): string {
  const primaryRole = ROLE_PRIORITY.find((role) => roles.includes(role));
  if (!primaryRole) {
    return DEFAULT_HOME;
  }
  // eslint-disable-next-line security/detect-object-injection -- `primaryRole` is drawn only from the fixed ROLE_PRIORITY list above, never external input
  return ROLE_HOME[primaryRole] ?? DEFAULT_HOME;
}
