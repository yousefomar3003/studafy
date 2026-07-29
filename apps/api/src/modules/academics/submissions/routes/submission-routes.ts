import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { CodedHttpException } from "../../../../coded-http-exception";
import { withTenantTx } from "../../../../db/tenant-tx";
import { requireStorage } from "../../../../lib/storage";
import { auditAction } from "../../../../middleware/auditEmitter";
import { requireAuth } from "../../../../middleware/authContext";
import { requirePermission } from "../../../../middleware/authz";
import { openApiValidationHook } from "../../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../../openapi/responses";
import {
  assignmentIdParamSchema,
  confirmSubmissionAttachmentBodySchema,
  createSubmissionBodySchema,
  createSubmissionUploadUrlBodySchema,
  gradeSubmissionBodySchema,
  submissionAttachmentIdParamSchema,
  submissionAttachmentSchema,
  submissionIdParamSchema,
  submissionListQuerySchema,
  submissionListSchema,
  submissionSchema,
  submissionUploadUrlSchema,
} from "../schemas";
import {
  confirmSubmissionAttachment,
  createSubmissionUploadUrl,
  deleteSubmissionAttachment,
  listAttachmentsBySubmission,
} from "../submission-attachment-service";
import {
  getSubmission,
  gradeIsVisible,
  gradeSubmission,
  isStaffForAssignment,
  listSubmissions,
  resolveCallerStudentId,
  submitAssignment,
} from "../submission-service";

import type { Database } from "../../../../db/client";
import type { StorageService } from "../../../../lib/storage";
import type { AppEnv } from "../../../../middleware/requestId";
import type { Submission, SubmissionAttachment } from "../schemas";
import type { SubmissionAttachmentRow } from "../submission-attachment-service";
import type { SubmissionRow } from "../submission-service";
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
 * POST identically. On this module they must differ: every role that can read a submission holds
 * submission:read, and only students hold submission:create.
 *
 * A Map rather than an object lookup because the key comes off the request line, and
 * eslint-plugin-security's detect-object-injection is right to object to indexing on that. Mirrors
 * the identical helper in the assignments module; kept local rather than shared because extracting
 * it would touch a shipped module for no behavioural gain.
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
 */
async function toAttachmentResponse(
  row: SubmissionAttachmentRow,
  storage: StorageService | null,
): Promise<SubmissionAttachment> {
  const presigned = storage ? await storage.presign(row.storage_key, "GET") : null;

  return {
    id: row.id,
    submission_id: row.submission_id,
    original_file_name: row.original_file_name,
    mime_type: row.mime_type,
    size_bytes: Number(row.size_bytes),
    checksum_sha256: row.checksum_sha256,
    attempt_number: row.attempt_number,
    download_url: presigned?.url ?? null,
    download_url_expires_at: presigned?.expiresAt.toISOString() ?? null,
    uploaded_by_user_id: row.uploaded_by_user_id,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * Project a stored submission onto its response shape, withholding an unreleased grade.
 *
 * THIS FUNCTION IS THE PRIVACY BOUNDARY. When `viewerIsStaff` is false and the grade has not been
 * published, score/feedback/graded_at/graded_by_user_id are all null and `grade_status` reports
 * `none`.
 *
 * `grade_status` is masked rather than passed through because reporting `draft` would leak exactly
 * the fact the nulls exist to hide -- that a teacher has started marking. A student can tell
 * "unmarked" from "marked" only after the teacher decides they may.
 *
 * `status` needs no masking, and that is not luck: 000049's lifecycle constraint was written so a
 * draft grade leaves `status` at `submitted`. The field the student already watches simply does not
 * move until publication.
 *
 * max_score-style note: `score` arrives from postgres.js as a string, because numeric is
 * arbitrary-precision and the driver will not narrow it behind your back. This is the one place it
 * becomes a number, so the lossy step is visible rather than scattered.
 */
export function toSubmissionResponse(
  row: SubmissionRow,
  attachments: SubmissionAttachment[],
  viewerIsStaff: boolean,
): Submission {
  const showGrade = gradeIsVisible(row, viewerIsStaff);

  return {
    id: row.id,
    school_id: row.school_id,
    assignment_id: row.assignment_id,
    student_id: row.student_id,
    content: row.content,
    status: row.status,
    grade_status: showGrade ? row.grade_status : "none",
    is_late: row.is_late,
    attempt_number: row.attempt_number,
    submitted_at: row.submitted_at?.toISOString() ?? null,
    score: showGrade && row.score !== null ? Number(row.score) : null,
    feedback: showGrade ? row.feedback : null,
    graded_at: showGrade ? (row.graded_at?.toISOString() ?? null) : null,
    graded_by_user_id: showGrade ? row.graded_by_user_id : null,
    attachments,
    last_edited_by_user_id: row.last_edited_by_user_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** Load attachments for a page of submissions in one query and project the whole page. */
async function hydrate(
  tx: TransactionSql,
  schoolId: string,
  rows: SubmissionRow[],
  storage: StorageService | null,
  viewerIsStaff: boolean,
): Promise<Submission[]> {
  const bySubmission = await listAttachmentsBySubmission(
    tx,
    schoolId,
    rows.map((row) => row.id),
  );

  return Promise.all(
    rows.map(async (row) =>
      toSubmissionResponse(
        row,
        await Promise.all(
          (bySubmission.get(row.id) ?? []).map((attachment) =>
            toAttachmentResponse(attachment, storage),
          ),
        ),
        viewerIsStaff,
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const createSubmissionRoute = createRoute({
  method: "post",
  path: "/api/academics/assignments/{assignmentId}/submissions",
  tags: ["Submissions"],
  operationId: "createSubmission",
  summary: "Hand in or resubmit work",
  description:
    "Records the calling student's work for an assignment. A student has at most one submission " +
    "per assignment: submitting again replaces the previous attempt atomically, increments " +
    "`attempt_number`, and clears any unpublished mark. Answers 201 on a first hand-in and 200 on " +
    "a resubmission. Work handed in after `due_at` is flagged `is_late` when the assignment " +
    "allows late submission, and rejected with 409 when it does not.",
  security: [{ bearerAuth: [] }],
  request: {
    params: assignmentIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: createSubmissionBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: { description: "The replaced submission.", schema: submissionSchema },
      201: { description: "The created submission.", schema: submissionSchema },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const listSubmissionsRoute = createRoute({
  method: "get",
  path: "/api/academics/assignments/{assignmentId}/submissions",
  tags: ["Submissions"],
  operationId: "listSubmissions",
  summary: "List submissions for an assignment",
  description:
    "Teachers of the assignment's class and school admins see every submission; a student sees " +
    "only their own, and a linked parent only their child's. Marks that have not been published " +
    "are withheld from students and parents -- the submission is returned, but `score`, " +
    "`feedback`, `graded_at` and `graded_by_user_id` are null and `grade_status` reads `none`.",
  security: [{ bearerAuth: [] }],
  request: { params: assignmentIdParamSchema, query: submissionListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Paginated list of submissions.", schema: submissionListSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const getSubmissionRoute = createRoute({
  method: "get",
  path: "/api/academics/submissions/{submissionId}",
  tags: ["Submissions"],
  operationId: "getSubmission",
  summary: "Get a submission",
  description:
    "Returns one submission with pre-signed download URLs for its attachments. Answers 404 when " +
    "the submission is outside the caller's scope, so one student cannot probe for another's " +
    "work. Unpublished marks are withheld as described on the list endpoint.",
  security: [{ bearerAuth: [] }],
  request: { params: submissionIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The submission.", schema: submissionSchema } },
    [401, 403, 404, 500],
  ),
});

const gradeSubmissionRoute = createRoute({
  method: "patch",
  path: "/api/academics/submissions/{submissionId}/grade",
  tags: ["Submissions"],
  operationId: "gradeSubmission",
  summary: "Grade a submission",
  description:
    "Records a mark on a submission for a class the caller teaches. With `publish: false` the " +
    "score and feedback are saved as a draft visible only to staff; with `publish: true` they are " +
    "released to the student and their linked parents and the submission moves to `graded`. " +
    "`return_to_student: true` instead sends the work back for another attempt, clearing any " +
    "draft mark and permitting resubmission even after the deadline.",
  security: [{ bearerAuth: [] }],
  request: {
    params: submissionIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: gradeSubmissionBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The graded submission.", schema: submissionSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const createUploadUrlRoute = createRoute({
  method: "post",
  path: "/api/academics/submissions/{submissionId}/attachments/upload-url",
  tags: ["Submissions"],
  operationId: "createSubmissionAttachmentUploadUrl",
  summary: "Get a pre-signed upload URL for a submission attachment",
  description:
    "Returns a short-lived pre-signed PUT URL and the staging storage key. Upload the file body " +
    "directly to the URL, then POST the key back to the attachments endpoint to confirm. Only the " +
    "student the submission belongs to may attach files. Answers 503 when the deployment has no " +
    "object storage configured.",
  security: [{ bearerAuth: [] }],
  request: {
    params: submissionIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: createSubmissionUploadUrlBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "Pre-signed upload URL and staging key.",
        schema: submissionUploadUrlSchema,
      },
    },
    [400, 401, 403, 404, 500],
  ),
});

const confirmAttachmentRoute = createRoute({
  method: "post",
  path: "/api/academics/submissions/{submissionId}/attachments",
  tags: ["Submissions"],
  operationId: "confirmSubmissionAttachment",
  summary: "Confirm an uploaded submission attachment",
  description:
    "Verifies the staged object exists, moves it to permanent storage, and records it against the " +
    "submission, stamped with the current `attempt_number`. The storage key must be one issued by " +
    "the upload-url endpoint for this school; any other key is rejected with 403.",
  security: [{ bearerAuth: [] }],
  request: {
    params: submissionIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: confirmSubmissionAttachmentBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The recorded attachment.", schema: submissionAttachmentSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const deleteAttachmentRoute = createRoute({
  method: "delete",
  path: "/api/academics/submissions/{submissionId}/attachments/{attachmentId}",
  tags: ["Submissions"],
  operationId: "deleteSubmissionAttachment",
  summary: "Delete a submission attachment",
  description:
    "Detaches a file from a submission. Only the owning student may do this -- a teacher can read " +
    "the files they are marking but cannot alter them. The stored object is left for a storage " +
    "sweep to reclaim rather than deleted inline, because an object delete cannot be rolled back " +
    "with the row.",
  security: [{ bearerAuth: [] }],
  request: { params: submissionAttachmentIdParamSchema },
  responses: {
    204: { description: "Attachment deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
  },
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Submissions routes (ST-104).
 *
 * `storage` is nullable so the app boots without object storage configured -- the routes still
 * register (and therefore still appear in the generated OpenAPI document, which is built with no
 * storage at all), and the ones that genuinely need a bucket answer 503 at request time via
 * requireStorage. Registering them conditionally would make the published contract depend on a
 * deployment's environment, which is a worse failure than an honest 503.
 */
export function submissionRoutes(
  database: Database,
  storage: StorageService | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Permission gates, per method. Teachers hold submission:read but not submission:create, and
  // students the reverse, so a path-wide gate on either would be wrong in one direction.
  routes.use(
    "/api/academics/assignments/{assignmentId}/submissions",
    permissionByMethod([
      ["GET", PERMISSIONS.SUBMISSION_READ],
      ["POST", PERMISSIONS.SUBMISSION_CREATE],
    ]),
  );
  routes.use(
    "/api/academics/submissions/{submissionId}",
    permissionByMethod([["GET", PERMISSIONS.SUBMISSION_READ]]),
  );
  routes.use(
    "/api/academics/submissions/{submissionId}/grade",
    permissionByMethod([["PATCH", PERMISSIONS.SUBMISSION_GRADE]]),
  );
  // submission:update rather than a permission of its own, and the choice does real work: only
  // STUDENT and the admin roles hold it. INSTRUCTOR and TEACHING_ASSISTANT do not, which is exactly
  // right -- a submission attachment is the student's evidence and a teacher must not be able to
  // add to it or remove from it. The service asserts ownership as the second half of the same rule.
  routes.use(
    "/api/academics/submissions/{submissionId}/attachments/upload-url",
    permissionByMethod([["POST", PERMISSIONS.SUBMISSION_UPDATE]]),
  );
  routes.use(
    "/api/academics/submissions/{submissionId}/attachments",
    permissionByMethod([["POST", PERMISSIONS.SUBMISSION_UPDATE]]),
  );
  routes.use(
    "/api/academics/submissions/{submissionId}/attachments/{attachmentId}",
    permissionByMethod([["DELETE", PERMISSIONS.SUBMISSION_UPDATE]]),
  );

  // Audit declarations. Read by the CI coverage gate (tests/audit-coverage.test.ts); the actual
  // rows are written inside each service transaction by emitAuditLog.
  routes.use(
    "/api/academics/assignments/{assignmentId}/submissions",
    auditAction("insert", "assignment_submissions"),
  );
  routes.use(
    "/api/academics/submissions/{submissionId}/grade",
    auditAction("update", "assignment_submissions"),
  );
  routes.use(
    "/api/academics/submissions/{submissionId}/attachments/upload-url",
    auditAction("update", "assignment_submissions"),
  );
  routes.use(
    "/api/academics/submissions/{submissionId}/attachments",
    auditAction("insert", "submission_attachments"),
  );
  routes.use(
    "/api/academics/submissions/{submissionId}/attachments/{attachmentId}",
    auditAction("delete", "submission_attachments"),
  );

  // --- Submissions ---

  routes.openapi(createSubmissionRoute, async (c) => {
    const auth = requireAuth(c);
    const { assignmentId } = c.req.valid("param");
    const body = c.req.valid("json");

    const result = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const studentId = await resolveCallerStudentId(tx, auth.schoolId);
      if (!studentId) {
        // Holding submission:create without being a student means an admin acting on somebody
        // else's behalf. There is no student to attribute the work to, so there is nothing to do.
        throw new CodedHttpException(
          403,
          ERROR_CODES.SUBMISSION_NOT_ENROLLED,
          "Only a student can submit work",
        );
      }

      const { row, created } = await submitAssignment(
        tx,
        auth.schoolId,
        auth.userId,
        studentId,
        assignmentId,
        body,
      );

      // The submitting student is never staff for their own work, so the grade projection is
      // resolved without another round trip.
      const [hydrated] = await hydrate(tx, auth.schoolId, [row], storage, false);
      return { submission: hydrated!, created };
    });

    return result.created ? c.json(result.submission, 201) : c.json(result.submission, 200);
  });

  routes.openapi(listSubmissionsRoute, async (c) => {
    const auth = requireAuth(c);
    const { assignmentId } = c.req.valid("param");
    const query = c.req.valid("query");

    const { submissions, total } = await withTenantTx(database, tenantFrom(c), async (tx) => {
      // Resolved once for the whole page: it is a property of the caller and the assignment, and
      // cannot differ between two rows on the same assignment.
      const viewerIsStaff = await isStaffForAssignment(tx, assignmentId);
      const callerStudentId = viewerIsStaff
        ? null
        : await resolveCallerStudentId(tx, auth.schoolId);

      const page = await listSubmissions(
        tx,
        auth.schoolId,
        assignmentId,
        query,
        viewerIsStaff,
        callerStudentId,
      );

      return {
        submissions: await hydrate(tx, auth.schoolId, page.rows, storage, viewerIsStaff),
        total: page.total,
      };
    });

    return c.json({ submissions, total }, 200);
  });

  routes.openapi(getSubmissionRoute, async (c) => {
    const auth = requireAuth(c);
    const { submissionId } = c.req.valid("param");

    const submission = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const row = await getSubmission(tx, auth.schoolId, submissionId);
      if (!row) return null;

      const viewerIsStaff = await isStaffForAssignment(tx, row.assignment_id);
      const [hydrated] = await hydrate(tx, auth.schoolId, [row], storage, viewerIsStaff);
      return hydrated ?? null;
    });

    if (!submission) {
      // 404 rather than 403 for a submission the caller cannot see: a student probing ids must not
      // be able to tell "exists but not yours" from "does not exist", which is the whole of
      // classmate privacy. Attempting to GRADE work outside your classes is a different case and
      // does answer 403 -- see assertCanGradeAssignment.
      throw new CodedHttpException(404, ERROR_CODES.SUBMISSION_NOT_FOUND, "Submission not found");
    }

    return c.json(submission, 200);
  });

  routes.openapi(gradeSubmissionRoute, async (c) => {
    const auth = requireAuth(c);
    const { submissionId } = c.req.valid("param");
    const body = c.req.valid("json");

    const submission = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const row = await gradeSubmission(tx, auth.schoolId, auth.userId, submissionId, body);
      // Only staff reach this handler -- gradeSubmission throws otherwise -- so the marks it just
      // wrote are visible in the response regardless of whether they were published.
      const [hydrated] = await hydrate(tx, auth.schoolId, [row], storage, true);
      return hydrated!;
    });

    return c.json(submission, 200);
  });

  // --- Attachments ---

  routes.openapi(createUploadUrlRoute, async (c) => {
    const auth = requireAuth(c);
    const { submissionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const active = requireStorage(storage);

    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      createSubmissionUploadUrl(tx, active, auth.schoolId, submissionId, body),
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
    const { submissionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const active = requireStorage(storage);

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      confirmSubmissionAttachment(tx, active, auth.schoolId, auth.userId, submissionId, body),
    );

    return c.json(await toAttachmentResponse(row, active), 201);
  });

  routes.openapi(deleteAttachmentRoute, async (c) => {
    const auth = requireAuth(c);
    const { submissionId, attachmentId } = c.req.valid("param");

    await withTenantTx(database, tenantFrom(c), (tx) =>
      deleteSubmissionAttachment(tx, auth.schoolId, submissionId, attachmentId),
    );

    return new Response(null, { status: 204 });
  });

  return routes;
}
