import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { CodedHttpException } from "../../../../coded-http-exception";
import { withTenantTx } from "../../../../db/tenant-tx";
import { requireStorage } from "../../../../lib/storage";
import { auditAction } from "../../../../middleware/auditEmitter";
import { requireAuth } from "../../../../middleware/authContext";
import { hasPermission, requirePermission } from "../../../../middleware/authz";
import { openApiValidationHook } from "../../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../../openapi/responses";
import {
  createAssignment,
  deleteAssignment,
  getAssignment,
  listAssignments,
  updateAssignment,
} from "../assignment-service";
import {
  confirmAttachment,
  createUploadUrl,
  deleteAttachment,
  listAttachmentsByAssignment,
} from "../attachment-service";
import {
  assignmentAttachmentSchema,
  assignmentIdParamSchema,
  assignmentListQuerySchema,
  assignmentListSchema,
  assignmentSchema,
  attachmentIdParamSchema,
  confirmAttachmentBodySchema,
  createAssignmentBodySchema,
  createUploadUrlBodySchema,
  updateAssignmentBodySchema,
  uploadUrlSchema,
} from "../schemas";

import type { Database } from "../../../../db/client";
import type { StorageService } from "../../../../lib/storage";
import type { AppEnv } from "../../../../middleware/requestId";
import type { AssignmentRow } from "../assignment-service";
import type { AttachmentRow } from "../attachment-service";
import type { Assignment, AssignmentAttachment } from "../schemas";
import type { Permission } from "@studafy/constants";
import type { Context, MiddlewareHandler } from "hono";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Apply a different permission per HTTP method on a single path.
 *
 * Hono mounts middleware by path, not by path-and-method, so one `routes.use` would gate GET and
 * POST identically. On this module they must differ: every role that can read an assignment holds
 * assignment:read, and only teachers and admins hold assignment:create.
 *
 * The guards are the standard requirePermission middleware, built once at registration rather than
 * per request. A Map rather than an object lookup because the key comes off the request line, and
 * eslint-plugin-security's detect-object-injection is right to object to indexing on that -- a Map
 * cannot walk a prototype chain whatever it is handed. This mirrors the reasoning in
 * middleware/authz.ts.
 */
function permissionByMethod(
  entries: readonly (readonly [string, Permission])[],
): MiddlewareHandler<AppEnv> {
  const guards = new Map(
    entries.map(([method, permission]) => [method, requirePermission(permission)] as const),
  );

  return async (c, next) => {
    const guard = guards.get(c.req.method.toUpperCase());
    // No entry means the method is not one this path serves; Hono's own router answers 405/404.
    if (!guard) return next();
    return guard(c, next);
  };
}

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

/**
 * Project a stored attachment onto its response shape, minting a pre-signed download URL.
 *
 * `storage_key` is deliberately absent from the output. It reveals the bucket layout, and the
 * layout is guessable enough that publishing one school's keys would hand a reader the shape of
 * every other school's. The pre-signed URL is the only handle a client gets, and it expires.
 *
 * When storage is unconfigured the row still renders, with a null URL. A deployment without object
 * storage should still be able to list assignments; failing the whole request over a download link
 * would take out the feature to protect an attachment.
 */
async function toAttachmentResponse(
  row: AttachmentRow,
  storage: StorageService | null,
): Promise<AssignmentAttachment> {
  const presigned = storage ? await storage.presign(row.storage_key, "GET") : null;

  return {
    id: row.id,
    assignment_id: row.assignment_id,
    original_file_name: row.original_file_name,
    mime_type: row.mime_type,
    size_bytes: Number(row.size_bytes),
    checksum_sha256: row.checksum_sha256,
    download_url: presigned?.url ?? null,
    download_url_expires_at: presigned?.expiresAt.toISOString() ?? null,
    uploaded_by_user_id: row.uploaded_by_user_id,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * Project a stored assignment onto its response shape.
 *
 * max_score arrives from postgres.js as a string, because numeric is arbitrary-precision and the
 * driver will not narrow it behind your back. This is the one place it becomes a number, so the
 * lossy step is visible rather than scattered.
 */
function toAssignmentResponse(row: AssignmentRow, attachments: AssignmentAttachment[]): Assignment {
  return {
    id: row.id,
    school_id: row.school_id,
    class_id: row.class_id,
    subject_id: row.subject_id,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    status: row.status,
    available_from: row.available_from?.toISOString() ?? null,
    assigned_at: row.assigned_at?.toISOString() ?? null,
    due_at: row.due_at.toISOString(),
    max_score: Number(row.max_score),
    allow_late_submission: row.allow_late_submission,
    attachments,
    created_by_user_id: row.created_by_user_id,
    last_edited_by_user_id: row.last_edited_by_user_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** Hydrate a page of assignments with their attachments in a single extra query. */
async function hydrate(
  tx: TransactionSql,
  schoolId: string,
  rows: AssignmentRow[],
  storage: StorageService | null,
): Promise<Assignment[]> {
  const byAssignment = await listAttachmentsByAssignment(
    tx,
    schoolId,
    rows.map((row) => row.id),
  );

  return Promise.all(
    rows.map(async (row) =>
      toAssignmentResponse(
        row,
        await Promise.all(
          (byAssignment.get(row.id) ?? []).map((attachment) =>
            toAttachmentResponse(attachment, storage),
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listAssignmentsRoute = createRoute({
  method: "get",
  path: "/api/academics/assignments",
  tags: ["Assignments"],
  operationId: "listAssignments",
  summary: "List assignments",
  description:
    "Cursor-paginated list of assignments visible to the caller. Teachers see every assignment " +
    "for the classes they teach, including drafts; students see only published work for classes " +
    "they are actively enrolled in. Supports filtering by class, subject, and derived status.",
  security: [{ bearerAuth: [] }],
  request: { query: assignmentListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Paginated list of assignments.", schema: assignmentListSchema } },
    [400, 401, 403, 500],
  ),
});

const createAssignmentRoute = createRoute({
  method: "post",
  path: "/api/academics/assignments",
  tags: ["Assignments"],
  operationId: "createAssignment",
  summary: "Create an assignment",
  description:
    "Creates an assignment for a class the caller teaches. Returns 403 for any other class. " +
    "Creating directly with status `published` additionally requires the assignment:publish " +
    "permission.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createAssignmentBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The created assignment.", schema: assignmentSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const getAssignmentRoute = createRoute({
  method: "get",
  path: "/api/academics/assignments/{assignmentId}",
  tags: ["Assignments"],
  operationId: "getAssignment",
  summary: "Get an assignment",
  description:
    "Returns one assignment with pre-signed download URLs for its attachments. Answers 404 when " +
    "the assignment is outside the caller's teaching or active-enrolment scope.",
  security: [{ bearerAuth: [] }],
  request: { params: assignmentIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The assignment.", schema: assignmentSchema } },
    [401, 403, 404, 500],
  ),
});

const updateAssignmentRoute = createRoute({
  method: "patch",
  path: "/api/academics/assignments/{assignmentId}",
  tags: ["Assignments"],
  operationId: "updateAssignment",
  summary: "Update an assignment",
  description:
    "Partially updates an assignment for a class the caller teaches. Moving status from `draft` " +
    "requires the assignment:publish permission. Returning a published assignment to `draft` is " +
    "rejected with 409.",
  security: [{ bearerAuth: [] }],
  request: {
    params: assignmentIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateAssignmentBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The updated assignment.", schema: assignmentSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteAssignmentRoute = createRoute({
  method: "delete",
  path: "/api/academics/assignments/{assignmentId}",
  tags: ["Assignments"],
  operationId: "deleteAssignment",
  summary: "Delete an assignment",
  description:
    "Deletes an assignment for a class the caller teaches. An assignment that already has student " +
    "submissions is archived instead of removed, so submitted work is never orphaned. Both " +
    "outcomes answer 204.",
  security: [{ bearerAuth: [] }],
  request: { params: assignmentIdParamSchema },
  responses: {
    204: { description: "Assignment deleted or archived.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
  },
});

const createUploadUrlRoute = createRoute({
  method: "post",
  path: "/api/academics/assignments/{assignmentId}/attachments/upload-url",
  tags: ["Assignments"],
  operationId: "createAssignmentAttachmentUploadUrl",
  summary: "Get a pre-signed upload URL for an attachment",
  description:
    "Returns a short-lived pre-signed PUT URL and the staging storage key. Upload the file body " +
    "directly to the URL, then POST the key back to the attachments endpoint to confirm. " +
    "Answers 503 when the deployment has no object storage configured.",
  security: [{ bearerAuth: [] }],
  request: {
    params: assignmentIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: createUploadUrlBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "Pre-signed upload URL and staging key.", schema: uploadUrlSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const confirmAttachmentRoute = createRoute({
  method: "post",
  path: "/api/academics/assignments/{assignmentId}/attachments",
  tags: ["Assignments"],
  operationId: "confirmAssignmentAttachment",
  summary: "Confirm an uploaded attachment",
  description:
    "Verifies the staged object exists, moves it to permanent storage, and records it against the " +
    "assignment. The storage key must be one issued by the upload-url endpoint for this school; " +
    "any other key is rejected with 403.",
  security: [{ bearerAuth: [] }],
  request: {
    params: assignmentIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: confirmAttachmentBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The recorded attachment.", schema: assignmentAttachmentSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const deleteAttachmentRoute = createRoute({
  method: "delete",
  path: "/api/academics/assignments/{assignmentId}/attachments/{attachmentId}",
  tags: ["Assignments"],
  operationId: "deleteAssignmentAttachment",
  summary: "Delete an attachment",
  description:
    "Detaches a file from an assignment. The stored object is left for a storage sweep to reclaim " +
    "rather than deleted inline, because an object delete cannot be rolled back with the row.",
  security: [{ bearerAuth: [] }],
  request: { params: attachmentIdParamSchema },
  responses: {
    204: { description: "Attachment deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
  },
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Assignment routes.
 *
 * `storage` is nullable so the app boots without object storage configured -- the routes still
 * register (and therefore still appear in the generated OpenAPI document, which is built with no
 * storage at all), and the ones that genuinely need a bucket answer 503 at request time via
 * requireStorage. Registering them conditionally would make the published contract depend on a
 * deployment's environment, which is a worse failure than an honest 503.
 */
export function assignmentRoutes(
  database: Database,
  storage: StorageService | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Permission gates, per method. Students hold assignment:read, so a path-wide read gate would
  // wave them through to POST and leave the refusal entirely to assertCanManageClass -- which is a
  // class-scope check, not a role check, and would answer the wrong question for a student with no
  // class at all.
  routes.use(
    "/api/academics/assignments",
    permissionByMethod([
      ["GET", PERMISSIONS.ASSIGNMENT_READ],
      ["POST", PERMISSIONS.ASSIGNMENT_CREATE],
    ]),
  );
  routes.use(
    "/api/academics/assignments/:assignmentId",
    permissionByMethod([
      ["GET", PERMISSIONS.ASSIGNMENT_READ],
      ["PATCH", PERMISSIONS.ASSIGNMENT_UPDATE],
      ["DELETE", PERMISSIONS.ASSIGNMENT_DELETE],
    ]),
  );
  // Attaching and detaching files edits the assignment, so both are assignment:update rather than
  // a permission of their own -- an attachment has no lifecycle apart from its assignment.
  routes.use(
    "/api/academics/assignments/:assignmentId/attachments/upload-url",
    permissionByMethod([["POST", PERMISSIONS.ASSIGNMENT_UPDATE]]),
  );
  routes.use(
    "/api/academics/assignments/:assignmentId/attachments",
    permissionByMethod([["POST", PERMISSIONS.ASSIGNMENT_UPDATE]]),
  );
  routes.use(
    "/api/academics/assignments/:assignmentId/attachments/:attachmentId",
    permissionByMethod([["DELETE", PERMISSIONS.ASSIGNMENT_UPDATE]]),
  );

  // Audit declarations. Read by the CI coverage gate (tests/audit-coverage.test.ts); the actual
  // rows are written inside each service transaction by emitAuditLog.
  routes.use("/api/academics/assignments", auditAction("insert", "assignments"));
  routes.use("/api/academics/assignments/:assignmentId", auditAction("update", "assignments"));
  routes.use(
    "/api/academics/assignments/:assignmentId/attachments/upload-url",
    auditAction("update", "assignments"),
  );
  routes.use(
    "/api/academics/assignments/:assignmentId/attachments",
    auditAction("insert", "assignment_attachments"),
  );
  routes.use(
    "/api/academics/assignments/:assignmentId/attachments/:attachmentId",
    auditAction("delete", "assignment_attachments"),
  );

  // --- Assignments ---

  routes.openapi(listAssignmentsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { assignments, next_cursor } = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const page = await listAssignments(tx, auth.schoolId, query);
      return { assignments: await hydrate(tx, auth.schoolId, page.rows, storage), ...page };
    });

    return c.json({ assignments, next_cursor }, 200);
  });

  routes.openapi(createAssignmentRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    // Creating straight into `published` skips the draft step, so it is a publish and is gated as
    // one. hasPermission() rather than a second requirePermission mount: the requirement depends on
    // the body, which middleware cannot see.
    if (body.status === "published" && !hasPermission(auth.roles, PERMISSIONS.ASSIGNMENT_PUBLISH)) {
      throw new CodedHttpException(
        403,
        ERROR_CODES.AUTHZ_FORBIDDEN,
        "Publishing an assignment requires the assignment:publish permission",
      );
    }

    const assignment = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const row = await createAssignment(tx, auth.schoolId, auth.userId, body);
      return toAssignmentResponse(row, []);
    });

    return c.json(assignment, 201);
  });

  routes.openapi(getAssignmentRoute, async (c) => {
    const auth = requireAuth(c);
    const { assignmentId } = c.req.valid("param");

    const assignment = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const row = await getAssignment(tx, auth.schoolId, assignmentId);
      if (!row) return null;
      const [hydrated] = await hydrate(tx, auth.schoolId, [row], storage);
      return hydrated ?? null;
    });

    if (!assignment) {
      // 404 rather than 403 for a class the caller cannot see: a student probing ids should not be
      // able to tell "exists but not yours" from "does not exist". Attempting to MANAGE another
      // teacher's class is a different case and does answer 403 -- see assertCanManageClass.
      throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Assignment not found");
    }

    return c.json(assignment, 200);
  });

  routes.openapi(updateAssignmentRoute, async (c) => {
    const auth = requireAuth(c);
    const { assignmentId } = c.req.valid("param");
    const body = c.req.valid("json");

    if (
      body.status !== undefined &&
      body.status !== "draft" &&
      !hasPermission(auth.roles, PERMISSIONS.ASSIGNMENT_PUBLISH)
    ) {
      throw new CodedHttpException(
        403,
        ERROR_CODES.AUTHZ_FORBIDDEN,
        "Changing assignment status requires the assignment:publish permission",
      );
    }

    const assignment = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const row = await updateAssignment(tx, auth.schoolId, auth.userId, assignmentId, body);
      const [hydrated] = await hydrate(tx, auth.schoolId, [row], storage);
      return hydrated!;
    });

    return c.json(assignment, 200);
  });

  routes.openapi(deleteAssignmentRoute, async (c) => {
    const auth = requireAuth(c);
    const { assignmentId } = c.req.valid("param");

    await withTenantTx(database, tenantFrom(c), (tx) =>
      deleteAssignment(tx, auth.schoolId, auth.userId, assignmentId),
    );

    return new Response(null, { status: 204 });
  });

  // --- Attachments ---

  routes.openapi(createUploadUrlRoute, async (c) => {
    const auth = requireAuth(c);
    const { assignmentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const active = requireStorage(storage);

    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      createUploadUrl(tx, active, auth.schoolId, assignmentId, body),
    );

    return c.json(
      {
        upload_url: result.upload_url,
        storage_key: result.storage_key,
        expires_at: result.expires_at.toISOString(),
      },
      201,
    );
  });

  routes.openapi(confirmAttachmentRoute, async (c) => {
    const auth = requireAuth(c);
    const { assignmentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const active = requireStorage(storage);

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      confirmAttachment(tx, active, auth.schoolId, auth.userId, assignmentId, body),
    );

    return c.json(await toAttachmentResponse(row, active), 201);
  });

  routes.openapi(deleteAttachmentRoute, async (c) => {
    const auth = requireAuth(c);
    const { assignmentId, attachmentId } = c.req.valid("param");

    await withTenantTx(database, tenantFrom(c), (tx) =>
      deleteAttachment(tx, auth.schoolId, assignmentId, attachmentId),
    );

    return new Response(null, { status: 204 });
  });

  return routes;
}
