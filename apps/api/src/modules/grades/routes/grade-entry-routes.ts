import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  bulkUpdateGradesBodySchema,
  gradeSchema,
  gradeSubmissionSchema,
  gradebookEntryListSchema,
  gradebookEntryQuerySchema,
  gradebookIdParamSchema,
  submissionIdParamSchema,
  submissionStatusUpdateBodySchema,
} from "../config/schemas";
import {
  assertCanManageGradebook,
  bulkUpdateGrades,
  getGradebookById,
  getSubmissionsWithGrades,
  updateSubmissionStatus,
} from "../grade-entry-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
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

const updateSubmissionStatusRoute = createRoute({
  method: "patch",
  path: "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/status",
  tags: ["Grade Entry"],
  operationId: "updateSubmissionStatus",
  summary: "Transition submission status",
  description:
    "Transition a grade submission along its state machine: " +
    "draft → submitted → approved → published, or submitted → rejected → draft. " +
    "The DB trigger sets audit timestamps and actor columns automatically. " +
    "Uses an updated_at concurrency guard.",
  security: [{ bearerAuth: [] }],
  request: {
    params: gradebookIdParamSchema.merge(submissionIdParamSchema),
    body: {
      required: true,
      content: { "application/json": { schema: submissionStatusUpdateBodySchema } },
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

export function gradeEntryRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

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
    "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/status",
    requirePermission(PERMISSIONS.GRADE_UPDATE),
  );
  routes.use(
    "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/status",
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

  // --- Update submission status ---

  routes.openapi(updateSubmissionStatusRoute, async (c) => {
    const auth = requireAuth(c);
    const { gradebookId, submissionId } = c.req.valid("param");
    const body = c.req.valid("json");

    const submission = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const gradebook = await getGradebookById(tx, auth.schoolId, gradebookId);
      await assertCanManageGradebook(tx, gradebook.class_id);
      const raw = await updateSubmissionStatus(
        tx,
        auth.schoolId,
        submissionId,
        body.status,
        body.updated_at,
        auth.userId,
      );
      return raw;
    });

    return c.json(toSubmissionResponse({ ...submission, grades: [] }), 200);
  });

  return routes;
}
