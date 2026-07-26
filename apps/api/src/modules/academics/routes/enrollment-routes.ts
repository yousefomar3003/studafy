import { z, createRoute, OpenAPIHono } from "@hono/zod-openapi";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  enrollStudent,
  listEnrollments,
  transferStudent,
  withdrawStudent,
} from "../enrollment-service";
import {
  classIdParamSchema,
  createEnrollmentBodySchema,
  enrollmentListSchema,
  enrollmentQuerySchema,
  enrollmentSchema,
  studentIdParamSchema,
  transferEnrollmentBodySchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listEnrollmentsRoute = createRoute({
  method: "get",
  path: "/api/academics/classes/{classId}/enrollments",
  tags: ["Academics"],
  operationId: "listEnrollments",
  summary: "List enrollments for a class",
  description: "Paginated list of enrollments belonging to the specified class.",
  security: [{ bearerAuth: [] }],
  request: {
    params: classIdParamSchema,
    query: enrollmentQuerySchema,
  },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of enrollments.",
        schema: enrollmentListSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const enrollStudentRoute = createRoute({
  method: "post",
  path: "/api/academics/classes/{classId}/enrollments",
  tags: ["Academics"],
  operationId: "enrollStudent",
  summary: "Enroll a student in a class",
  description: "Enrolls a student in the specified class. Rejects if the class is at capacity.",
  security: [{ bearerAuth: [] }],
  request: {
    params: classIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: createEnrollmentBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created enrollment.",
        schema: enrollmentSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const withdrawStudentRoute = createRoute({
  method: "delete",
  path: "/api/academics/classes/{classId}/enrollments/{studentId}",
  tags: ["Academics"],
  operationId: "withdrawStudent",
  summary: "Withdraw a student from a class",
  description:
    "Withdraws a student from the specified class. Sets the enrollment status to " +
    "withdrawn and records the withdrawal timestamp.",
  security: [{ bearerAuth: [] }],
  request: {
    params: classIdParamSchema.merge(studentIdParamSchema),
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated enrollment.",
        schema: enrollmentSchema,
      },
    },
    [401, 403, 404, 409, 500],
  ),
});

const transferStudentRoute = createRoute({
  method: "post",
  path: "/api/academics/classes/{classId}/enrollments/transfer",
  tags: ["Academics"],
  operationId: "transferStudent",
  summary: "Transfer a student between classes",
  description:
    "Transfers a student from the specified class to a destination class. " +
    "Withdraws from the source class (preserving history) and enrolls in the " +
    "destination class with a capacity check.",
  security: [{ bearerAuth: [] }],
  request: {
    params: classIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: transferEnrollmentBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Transfer completed. Returns both source and destination enrollments.",
        schema: z.object({
          source: enrollmentSchema,
          destination: enrollmentSchema,
        }),
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

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
// Route factory
// ---------------------------------------------------------------------------

export function enrollmentRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Audit declarations
  routes.use("/api/academics/classes/{classId}/enrollments", auditAction("insert", "enrollments"));
  routes.use(
    "/api/academics/classes/{classId}/enrollments/{studentId}",
    auditAction("update", "enrollments"),
  );
  routes.use(
    "/api/academics/classes/{classId}/enrollments/transfer",
    auditAction("update", "enrollments"),
  );

  routes.openapi(listEnrollmentsRoute, async (c) => {
    const auth = requireAuth(c);
    const { classId } = c.req.valid("param");
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listEnrollments(tx, auth.schoolId, classId, query),
    );

    return c.json({ enrollments: rows, total }, 200);
  });

  routes.openapi(enrollStudentRoute, async (c) => {
    const auth = requireAuth(c);
    const { classId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      enrollStudent(tx, auth.schoolId, classId, body.student_id),
    );

    return c.json(row, 201);
  });

  routes.openapi(withdrawStudentRoute, async (c) => {
    const auth = requireAuth(c);
    const { classId, studentId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      withdrawStudent(tx, auth.schoolId, classId, studentId),
    );

    return c.json(row, 200);
  });

  routes.openapi(transferStudentRoute, async (c) => {
    const auth = requireAuth(c);
    const { classId } = c.req.valid("param");
    const body = c.req.valid("json");

    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      transferStudent(tx, auth.schoolId, classId, body.to_class_id, body.student_id),
    );

    return c.json(result, 200);
  });

  return routes;
}
