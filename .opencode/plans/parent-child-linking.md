# Parent-Child Linking API - Implementation Plan

## Overview

Add admin endpoints for linking parent users to students (with relationship type) and unlinking them. The link/unlink operations drive parent permission inheritance: a linked parent gets read access scoped to their linked children only.

## Scope

**In scope:**

- Add `PARENT` role to the role enum and permission matrix
- `POST /api/students/{studentId}/guardians` — link a parent user to a student
- `DELETE /api/students/{studentId}/guardians/{userId}` — unlink a parent from a student
- Audit logging for both link and unlink operations
- Integration tests for link/unlink service functions

**Out of scope:**

- Parent account creation (use existing `POST /api/users` with `role=PARENT`)
- Parent-scoped data access enforcement (the link/unlink API sets up the data; scope enforcement is a separate task)
- Frontend changes

---

## Files to Modify

### 1. `packages/constants/src/roles.ts` — Add PARENT role

Add `PARENT: "PARENT"` to the `ROLES` constant.

### 2. `packages/constants/src/permissions.ts` — Add parent permissions + role mapping

Add new permissions:

```typescript
PARENT_LINK: "parent:link",
PARENT_UNLINK: "parent:unlink",
```

Add `PARENT_PERMISSIONS` array with scoped read permissions:

- `STUDENT_READ` (base permission; scope enforcement is a separate concern)

Add `PARENT` entry to `ROLE_PERMISSIONS`.

Update `ORG_ADMIN_PERMISSIONS` to include the new parent permissions (they should already be included via `ALL_PERMISSIONS` filter, but verify).

### 3. `packages/constants/src/errors.ts` — Add error codes

```typescript
PARENT_LINK_EXISTS: "PARENT_LINK_EXISTS",
PARENT_NOT_LINKED: "PARENT_NOT_LINKED",
PARENT_INVALID_ROLE: "PARENT_INVALID_ROLE",
STUDENT_NOT_FOUND: "STUDENT_NOT_FOUND",
```

### 4. `apps/api/src/modules/users/schemas.ts` — Add link/unlink schemas

Add request body schema:

```typescript
export const linkGuardianBodySchema = z
  .object({
    parent_user_id: uuidSchema,
    relationship: parentRelationshipSchema,
  })
  .openapi("LinkGuardianBody");
```

Add param schema for unlink (reuse existing `studentIdParamSchema` + add `userId` param):

```typescript
export const guardianParamSchema = z
  .object({
    studentId: z
      .string()
      .uuid()
      .openapi({ param: { name: "studentId", in: "path" } }),
    userId: z
      .string()
      .uuid()
      .openapi({ param: { name: "userId", in: "path" } }),
  })
  .openapi("GuardianParam");
```

Add response schemas for link/unlink results.

### 5. `apps/api/src/modules/users/student-service.ts` — Add link/unlink service functions

```typescript
export async function linkParentToStudent(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  parentUserId: string,
  relationship: ParentRelationship,
): Promise<GuardianRow>;
```

Logic:

1. Verify student exists (404 if not)
2. Verify parent user exists and has PARENT role (404 if not found, 400 if wrong role)
3. Check link doesn't already exist (409 if duplicate)
4. INSERT INTO app.parent_child_links
5. Emit audit log (action: "insert", targetTable: "parent_child_links")

```typescript
export async function unlinkParentFromStudent(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  parentUserId: string,
): Promise<void>;
```

Logic:

1. Verify link exists (404 if not)
2. DELETE FROM app.parent_child_links WHERE ...
3. Emit audit log (action: "delete", targetTable: "parent_child_links")

### 6. `apps/api/src/modules/users/routes/student-routes.ts` — Add link/unlink routes

**Link route:**

```typescript
const linkGuardianRoute = createRoute({
  method: "post",
  path: "/api/students/{studentId}/guardians",
  tags: ["Students"],
  operationId: "linkGuardian",
  summary: "Link a guardian to a student",
  security: [{ bearerAuth: [] }],
  request: {
    params: studentIdParamSchema,
    body: { required: true, content: { "application/json": { schema: linkGuardianBodySchema } } },
  },
  responses: standardResponses(
    { 201: { description: "The created guardian link.", schema: guardianSchema } },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});
```

**Unlink route:**

```typescript
const unlinkGuardianRoute = createRoute({
  method: "delete",
  path: "/api/students/{studentId}/guardians/{userId}",
  tags: ["Students"],
  operationId: "unlinkGuardian",
  summary: "Unlink a guardian from a student",
  security: [{ bearerAuth: [] }],
  request: { params: guardianParamSchema },
  responses: standardResponses(
    { 204: { description: "Guardian unlinked." } },
    [401, 403, 404, 429, 500],
  ),
});
```

Middleware in the route factory:

```typescript
routes.use("/api/students/{studentId}/guardians", requirePermission(PERMISSIONS.STUDENT_UPDATE));
routes.use(
  "/api/students/{studentId}/guardians/{userId}",
  requirePermission(PERMISSIONS.STUDENT_UPDATE),
);
routes.use("/api/students/{studentId}/guardians", auditAction("insert", "parent_child_links"));
routes.use(
  "/api/students/{studentId}/guardians/{userId}",
  auditAction("delete", "parent_child_links"),
);
```

### 7. `apps/api/src/modules/users/__tests__/parent-links.test.ts` — Add integration tests

New test file with tests:

- `linkParentToStudent` creates a link and emits audit
- `linkParentToStudent` rejects duplicate link (409)
- `linkParentToStudent` rejects non-existent student (404)
- `linkParentToStudent` rejects user without PARENT role (400)
- `unlinkParentFromStudent` removes the link and emits audit
- `unlinkParentFromStudent` rejects non-existent link (404)

---

## Dependency Order

1. `packages/constants/src/errors.ts` — add error codes
2. `packages/constants/src/roles.ts` — add PARENT role
3. `packages/constants/src/permissions.ts` — add permissions + role mapping
4. `apps/api/src/modules/users/schemas.ts` — add request/response schemas
5. `apps/api/src/modules/users/student-service.ts` — add service functions
6. `apps/api/src/modules/users/routes/student-routes.ts` — add routes
7. `apps/api/src/modules/users/__tests__/parent-links.test.ts` — add tests

---

## Verification

1. `bun run typecheck` — TypeScript compilation passes
2. `bun run lint` — ESLint passes
3. `bun test apps/api/src/modules/users/__tests__/parent-links.test.ts` — tests pass (requires TEST_DATABASE_URL)
4. `bun run test:audit-coverage` — audit coverage check passes (every mutating route has auditAction)
5. CI: migration, container, and quality checks pass
