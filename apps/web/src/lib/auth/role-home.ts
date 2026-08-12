/**
 * Where a freshly authenticated session lands. Today's only caller is the invitation activation
 * flow (`routes/invite/InviteCompletePage.tsx`), routing a just-activated user home by role.
 *
 * The web app has exactly one authenticated home right now (`/portal` — see `app/routes.tsx`), so
 * every invitable role resolves there. This map exists so that changes when a per-role destination
 * (an admin console, a distinct student view, ...) ships: it becomes a one-line edit here instead of
 * a hunt through every flow that routes a user home. `ROLE_PRIORITY` decides which destination wins
 * if a session ever carries more than one matching role.
 *
 * Roles are carried as plain strings, not the `@studafy/constants` `Role` union. The web app already
 * treats role values this way at its other boundary (`lib/realtime/protocol.ts`): validating a role
 * is the server's job; the client only needs to route on the value it was handed.
 */
const DEFAULT_HOME = "/portal";

const ROLE_HOME: Readonly<Record<string, string>> = {
  ORG_ADMIN: "/portal",
  INSTRUCTOR: "/portal",
  TEACHING_ASSISTANT: "/portal",
  STUDENT: "/portal",
  GUEST: "/portal",
};

/** Most- to least-privileged, matching `ROLE_HOME`'s keys. Only used to break ties on multi-role sessions. */
const ROLE_PRIORITY: readonly string[] = [
  "ORG_ADMIN",
  "INSTRUCTOR",
  "TEACHING_ASSISTANT",
  "STUDENT",
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
