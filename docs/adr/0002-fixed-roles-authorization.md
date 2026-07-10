# ADR-002: Fixed-role authorization model

## Status

Accepted

## Context

Studafy needs an authorization model shared by every app/service: a way to answer "can this
caller do X" consistently, without each service inventing its own role names or permission
strings. ST-004 asks for 7 predefined roles and a ~90-entry permission matrix, with an
explicit requirement to keep the model "simple, explicit, and auditable" and to avoid
over-engineering RBAC.

## Decision

- Roles are a **fixed, compile-time enumeration** (`ROLES` in `packages/constants/src/roles.ts`):
  `SUPER_ADMIN`, `ORG_ADMIN`, `INSTRUCTOR`, `TEACHING_ASSISTANT`, `STUDENT`, `GUEST`,
  `SUPPORT_AGENT`. There is no "create a custom role" capability and no database table backing
  role definitions.
- Permissions are `resource:action` string literals (`PERMISSIONS` in
  `packages/constants/src/permissions.ts`), and role → permission assignment
  (`ROLE_PERMISSIONS`) is a static object literal in the same package — not stored in a
  database, not computed at runtime, not user-editable.
- A caller's authorization check is a single lookup: does
  `ROLE_PERMISSIONS[caller.role]` include the required permission. No permission inheritance
  graph, no wildcard/glob matching, no attribute-based conditions.
- Both `PERMISSIONS` and `ROLE_PERMISSIONS` live in one package (`@studafy/constants`), so
  every service imports the same objects — there is exactly one place authorization data can
  be wrong, and it's covered by unit tests (every permission reachable by ≥1 role, every error
  code value unique).
- The permission-matrix documentation (`packages/constants/docs/permission-matrix.md`) is
  **generated** from these objects (`bun run docs:generate`), not hand-written, so docs cannot
  drift from the actual matrix.

## Alternatives considered

- **Database-backed roles/permissions (dynamic RBAC)** — lets an admin create custom roles or
  reassign permissions at runtime without a deploy. Rejected: it moves the authorization model
  out of code review and version control, directly conflicting with "explicit and auditable."
  A permission change would no longer show up as a diff in a PR. Revisit only if a concrete
  product requirement needs runtime-configurable roles (none exists today).
- **Attribute-based access control (ABAC) / policy engine (e.g. OPA, CASL conditions)** — more
  expressive (row-level, context-aware rules), but a large increase in surface area and a new
  runtime dependency for a 7-role, single-tenant-scoped matrix. Rejected as over-engineering
  for the current requirement; row-level scoping (e.g. "student can only read their own grade")
  stays the caller's application-layer responsibility, not this package's.
- **Permission inheritance / role hierarchy** (e.g. `ORG_ADMIN` implicitly inherits
  `INSTRUCTOR`) — saves repetition in the role-permission lists, but makes "what can this role
  actually do" require walking a hierarchy instead of reading one flat array. Rejected for
  auditability; each role's permission list in `ROLE_PERMISSIONS` is written out explicitly
  (`ORG_ADMIN`'s list is derived once from "all permissions minus platform-only ones" in code,
  but the resulting array is still a flat, directly-inspectable list of permissions, not a
  reference to another role).

## Consequences

- Adding a role or permission is a code change reviewed like any other — not a runtime admin
  action. This is intentional: `git blame` on `permissions.ts` is the audit log for "who added
  this permission and why."
- Row-level/contextual authorization (e.g. "only the enrolled student" or "only within their
  own organization") is explicitly out of scope for this package. Callers combine a
  `PERMISSIONS` check with their own scoping logic.
- If a future requirement needs runtime-configurable roles, that is a new, separate system
  layered on top of (or replacing) this one — not a change to make silently inside
  `@studafy/constants`.
