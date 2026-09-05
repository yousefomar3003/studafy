import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import { createExam, deleteExam, getExamById, listExams, updateExam } from "../exam-service";
import {
  createExamBodySchema,
  examIdParamSchema,
  examListSchema,
  examQuerySchema,
  examSchema,
  examWithWarningsSchema,
  updateExamBodySchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
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

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listExamsRoute = createRoute({
  method: "get",
  path: "/api/academics/exams",
  tags: ["Academics"],
  operationId: "listExams",
  summary: "List exams",
  description: "Paginated list of exams for a given class, ordered by start time descending.",
  security: [{ bearerAuth: [] }],
  request: { query: examQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of exams.",
        schema: examListSchema,
      },
    },
    [401, 403, 500],
  ),
});

const createExamRoute = createRoute({
  method: "post",
  path: "/api/academics/exams",
  tags: ["Academics"],
  operationId: "createExam",
  summary: "Create an exam",
  description:
    "Creates a new exam for a class. Returns the exam alongside any timetable conflict warnings " +
    "(day-level overlap with approved timetable slots for the same class or room).",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createExamBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created exam with any timetable conflict warnings.",
        schema: examWithWarningsSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const getExamRoute = createRoute({
  method: "get",
  path: "/api/academics/exams/{examId}",
  tags: ["Academics"],
  operationId: "getExam",
  summary: "Get an exam",
  description: "Returns a single exam by ID.",
  security: [{ bearerAuth: [] }],
  request: { params: examIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The exam.",
        schema: examSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const updateExamRoute = createRoute({
  method: "patch",
  path: "/api/academics/exams/{examId}",
  tags: ["Academics"],
  operationId: "updateExam",
  summary: "Update an exam",
  description:
    "Partially updates an exam. Returns the updated exam alongside any timetable conflict warnings.",
  security: [{ bearerAuth: [] }],
  request: {
    params: examIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateExamBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated exam with any timetable conflict warnings.",
        schema: examWithWarningsSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteExamRoute = createRoute({
  method: "delete",
  path: "/api/academics/exams/{examId}",
  tags: ["Academics"],
  operationId: "deleteExam",
  summary: "Delete an exam",
  description: "Hard-deletes an exam. Only draft or scheduled exams can be deleted.",
  security: [{ bearerAuth: [] }],
  request: { params: examIdParamSchema },
  responses: {
    204: { description: "Exam deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 500]),
  },
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function examRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Audit declarations
  routes.use("/api/academics/exams", auditAction("insert", "exams"));
  routes.use("/api/academics/exams/:examId", auditAction("update", "exams"));

  routes.openapi(listExamsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listExams(tx, auth.schoolId, query),
    );

    return c.json({ exams: rows, total }, 200);
  });

  routes.openapi(createExamRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      createExam(tx, auth.schoolId, auth.userId, body),
    );

    return c.json(result, 201);
  });

  routes.openapi(getExamRoute, async (c) => {
    const auth = requireAuth(c);
    const { examId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getExamById(tx, auth.schoolId, examId),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Exam not found" });
    }

    return c.json(row, 200);
  });

  routes.openapi(updateExamRoute, async (c) => {
    const auth = requireAuth(c);
    const { examId } = c.req.valid("param");
    const body = c.req.valid("json");

    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateExam(tx, auth.schoolId, examId, auth.userId, body),
    );

    return c.json(result, 200);
  });

  routes.openapi(deleteExamRoute, async (c) => {
    const auth = requireAuth(c);
    const { examId } = c.req.valid("param");

    await withTenantTx(database, tenantFrom(c), (tx) => deleteExam(tx, auth.schoolId, examId));

    return new Response(null, { status: 204 });
  });

  return routes;
}
