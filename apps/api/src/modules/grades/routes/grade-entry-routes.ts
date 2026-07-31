import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { PERMISSIONS, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  bulkUpdateGradesBodySchema,
  decideBodySchema,
  gradeSchema,
  gradeSubmissionSchema,
  gradebookEntryListSchema,
  gradebookEntryQuerySchema,
  gradebookIdParamSchema,
  submissionIdParamSchema,
  submitBodySchema,
  unlockBodySchema,
} from "../config/schemas";
import { enqueueNotificationDispatch } from "../enqueue-dispatch";
import {
  assertCanManageGradebook,
  bulkUpdateGrades,
  decideSubmission,
  getGradebookById,
  getSubmissionsWithGrades,
  submitSubmission,
  unlockSubmission,
} from "../grade-entry-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type { GradeRow, GradeSubmissionWithGrades } from "../grade-entry-service";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function toGradeResponse(row: GradeRow): {
  id: string;
  grade_submission_id: string;
  score: number | null;
  max_score: number;
  weight: number;
  label: string;
  created_at: string;
  updated_at: string;
} {
  return {
    id: row.id,
    grade_submission_id: row.grade_submission_id,
    score: row.score !== null ? Number(row.score) : null,
    max_score: Number(row.max_score),
    weight: Number(row.weight),
    label: row.label,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function toSubmissionResponse(row: GradeSubmissionWithGrades & { grades: GradeRow[] }): {
  id: string;
  gradebook_id: string;
  student_id: string;
  status: "draft" | "submitted" | "approved" | "rejected" | "published";
  submitted_by_user_id: string | null;
  decided_by_user_id: string | null;
  rejection_reason: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  grades: ReturnType<typeof toGradeResponse>[];
} {
  return {
    id: row.id,
    gradebook_id: row.gradebook_id,
    student_id: row.student_id,
    status: row.status as "draft" | "submitted" | "approved" | "rejected" | "published",
    submitted_by_user_id: row.submitted_by_user_id,
    decided_by_user_id: row.decided_by_user_id,
    rejection_reason: row.rejection_reason,
    submitted_at: row.submitted_at?.toISOString() ?? null,
    decided_at: row.decided_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    grades: row.grades.map(toGradeResponse),
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getGradebookEntryRoute = createRoute({
  method: "get",
  path: "/api/grades/gradebooks/{gradebookId}/entry",
  tags: ["Grade Entry"],
  operationId: "getGradebookEntry",
  summary: "Get gradebook entry grid",
  description:
    "Returns all grade submissions for a gradebook, each populated with their grade records. " +
    "Auto-creates draft submissions for enrolled students who do not yet have one. " +
    "Optionally filter by submission status.",
  security: [{ bearerAuth: [] }],
  request: {
    params: gradebookIdParamSchema,
    query: gradebookEntryQuerySchema,
  },
  responses: standardResponses(
    { 200: { description: "Gradebook entry grid.", schema: gradebookEntryListSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const bulkUpdateGradesRoute = createRoute({
  method: "patch",
  path: "/api/grades/gradebooks/{gradebookId}/grades",
  tags: ["Grade Entry"],
  operationId: "bulkUpdateGrades",
  summary: "Bulk update grade scores",
  description:
    "Atomically update up to 100 grade scores in a single transaction. " +
    "Each entry must carry the `updated_at` token from the client's last read. " +
    "If the row has been modified since then, the entire batch is rejected with 409. " +
    "Scores are validated against each grade record's max_score.",
  security: [{ bearerAuth: [] }],
  request: {
    params: gradebookIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: bulkUpdateGradesBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Updated grade records in input order.",
        schema: z.array(gradeSchema),
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const submitSubmissionRoute = createRoute({
  method: "patch",
  path: "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/submit",
  tags: ["Grade Workflow"],
  operationId: "submitGradeSubmission",
  summary: "Submit draft grade for approval",
  description:
    "Submit a draft grade submission for administrative review. " +
    "Only the assigned teacher may perform this action. " +
    "Emits a grades.submitted domain event.",
  security: [{ bearerAuth: [] }],
  request: {
    params: gradebookIdParamSchema.merge(submissionIdParamSchema),
    body: {
      required: true,
      content: { "application/json": { schema: submitBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The updated submission.", schema: gradeSubmissionSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const decideSubmissionRoute = createRoute({
  method: "patch",
  path: "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/decide",
  tags: ["Grade Workflow"],
  operationId: "decideGradeSubmission",
  summary: "Approve or reject a submitted grade",
  description:
    "Administrative decision on a submitted grade. " +
    "Approve auto-publishes the submission and emits a grades.published event. " +
    "Reject requires a rejection reason and returns the submission to rejected status. " +
    "Only school administrators may perform this action.",
  security: [{ bearerAuth: [] }],
  request: {
    params: gradebookIdParamSchema.merge(submissionIdParamSchema),
    body: {
      required: true,
      content: { "application/json": { schema: decideBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The updated submission.", schema: gradeSubmissionSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const unlockSubmissionRoute = createRoute({
  method: "patch",
  path: "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/unlock",
  tags: ["Grade Workflow"],
  operationId: "unlockGradeSubmission",
  summary: "Unlock a rejected submission for editing",
  description:
    "Return a rejected submission to draft so the teacher can edit and resubmit. " +
    "Only the assigned teacher may perform this action.",
  security: [{ bearerAuth: [] }],
  request: {
    params: gradebookIdParamSchema.merge(submissionIdParamSchema),
    body: {
      required: true,
      content: { "application/json": { schema: unlockBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The updated submission.", schema: gradeSubmissionSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function gradeEntryRoutes(
  database: Database,
  redis: RedisClient | null = null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Nullable for the same reason every other producer in this app is: REDIS_URL is optional, and
  // dev, test and the OpenAPI generator all run without it. Without Redis the API still publishes
  // grades perfectly well; it simply notifies nobody.
  const notificationsQueue = redis
    ? new Queue(QUEUE_NAMES.NOTIFICATIONS, { connection: redis as never })
    : null;

  routes.use(
    "/api/grades/gradebooks/{gradebookId}/entry",
    requirePermission(PERMISSIONS.GRADE_READ),
  );
  routes.use(
    "/api/grades/gradebooks/{gradebookId}/grades",
    requirePermission(PERMISSIONS.GRADE_UPDATE),
  );
  routes.use("/api/grades/gradebooks/{gradebookId}/grades", auditAction("update", "grades"));

  routes.use(
    "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/submit",
    requirePermission(PERMISSIONS.GRADE_UPDATE),
  );
  routes.use(
    "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/submit",
    auditAction("update", "grade_submissions"),
  );

  routes.use(
    "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/decide",
    requirePermission(PERMISSIONS.GRADE_OVERRIDE),
  );
  routes.use(
    "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/decide",
    auditAction("update", "grade_submissions"),
  );

  routes.use(
    "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/unlock",
    requirePermission(PERMISSIONS.GRADE_UPDATE),
  );
  routes.use(
    "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/unlock",
    auditAction("update", "grade_submissions"),
  );

  // --- Get gradebook entry grid ---

  routes.openapi(getGradebookEntryRoute, async (c) => {
    const auth = requireAuth(c);
    const { gradebookId } = c.req.valid("param");
    const { status } = c.req.valid("query");

    const submissions = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const gradebook = await getGradebookById(tx, auth.schoolId, gradebookId);
      await assertCanManageGradebook(tx, gradebook.class_id);
      return getSubmissionsWithGrades(tx, auth.schoolId, gradebookId, status);
    });

    return c.json({ submissions: submissions.map(toSubmissionResponse) }, 200);
  });

  // --- Bulk update grades ---

  routes.openapi(bulkUpdateGradesRoute, async (c) => {
    const auth = requireAuth(c);
    const { gradebookId } = c.req.valid("param");
    const body = c.req.valid("json");

    const grades = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const gradebook = await getGradebookById(tx, auth.schoolId, gradebookId);
      await assertCanManageGradebook(tx, gradebook.class_id);
      return bulkUpdateGrades(tx, auth.schoolId, gradebookId, body.grades);
    });

    return c.json(grades.map(toGradeResponse), 200);
  });

  // --- Submit draft for approval ---

  routes.openapi(submitSubmissionRoute, async (c) => {
    const auth = requireAuth(c);
    const { gradebookId, submissionId } = c.req.valid("param");
    const body = c.req.valid("json");

    const submission = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const gradebook = await getGradebookById(tx, auth.schoolId, gradebookId);
      await assertCanManageGradebook(tx, gradebook.class_id);
      return submitSubmission(
        tx,
        auth.schoolId,
        gradebookId,
        submissionId,
        body.updated_at,
        auth.userId,
      );
    });

    return c.json(toSubmissionResponse({ ...submission, grades: [] }), 200);
  });

  // --- Approve or reject ---

  routes.openapi(decideSubmissionRoute, async (c) => {
    const auth = requireAuth(c);
    const { gradebookId, submissionId } = c.req.valid("param");
    const body = c.req.valid("json");

    const submission = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const gradebook = await getGradebookById(tx, auth.schoolId, gradebookId);
      await assertCanManageGradebook(tx, gradebook.class_id);
      return decideSubmission(
        tx,
        auth.schoolId,
        submissionId,
        body.action,
        body.updated_at,
        auth.userId,
        body.rejection_reason,
      );
    });

    // ST-139: approve chains straight through to published, so this is the moment the student and
    // their parents become notifiable.
    //
    // Enqueued after the transaction commits, not inside it — a job referencing rows that were
    // rolled back is worse than a job that was never queued. The cost is a genuine gap: a crash
    // between COMMIT and this line loses the notification for that publication, and only a replay
    // recovers it. Same trade, for the same reason, as ../attendance/enqueue-alerts.ts.
    if (submission.status === "published") {
      await enqueueNotificationDispatch(notificationsQueue, c, {
        schoolId: auth.schoolId,
        submissionId,
      });
    }

    return c.json(toSubmissionResponse({ ...submission, grades: [] }), 200);
  });

  // --- Unlock rejected submission ---

  routes.openapi(unlockSubmissionRoute, async (c) => {
    const auth = requireAuth(c);
    const { gradebookId, submissionId } = c.req.valid("param");
    const body = c.req.valid("json");

    const submission = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const gradebook = await getGradebookById(tx, auth.schoolId, gradebookId);
      await assertCanManageGradebook(tx, gradebook.class_id);
      return unlockSubmission(tx, auth.schoolId, gradebookId, submissionId, body.updated_at);
    });

    return c.json(toSubmissionResponse({ ...submission, grades: [] }), 200);
  });

  return routes;
}
