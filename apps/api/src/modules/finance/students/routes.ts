import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";
import { uuidSchema } from "@studafy/shared-schemas";

import { CodedHttpException } from "../../../coded-http-exception";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import { getStudentIdentity, searchStudentIdentities, withStudentIdentityTx } from "./service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";

const studentSearchQuerySchema = z
  .object({
    search: z.string().trim().max(100).default("").openapi({
      description: "Part of a name. Empty lists every current student, alphabetically.",
    }),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .openapi("FinanceStudentSearchQuery");

const studentIdentityListSchema = z
  .object({
    students: z.array(z.object({ id: uuidSchema, name: z.string(), admission_number: z.string() })),
  })
  .openapi("FinanceStudentList");

const searchStudentsRoute = createRoute({
  method: "get",
  path: "/api/finance/students",
  tags: ["Finance"],
  operationId: "searchFinanceStudents",
  summary: "List students to pick for billing, awards, or reports",
  description:
    "The school's current students by name, filtered by `search` when given. Identity only (id, " +
    "name, admission number), so finance staff, who cannot read student records, can pick one. " +
    "Withdrawn students are excluded.",
  security: [{ bearerAuth: [] }],
  request: { query: studentSearchQuerySchema },
  responses: standardResponses(
    { 200: { description: "Matching students.", schema: studentIdentityListSchema } },
    [400, 401, 403, 500],
  ),
});

const studentIdParamSchema = z
  .object({
    studentId: uuidSchema.openapi({ param: { name: "studentId", in: "path" } }),
  })
  .openapi("FinanceStudentIdParam");

const studentIdentitySchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    admission_number: z.string(),
    status: z.string().openapi({ description: "Enrolment status, e.g. 'enrolled', 'withdrawn'." }),
    family_id: uuidSchema.nullable().openapi({ description: "Null when no guardian is linked." }),
    family_name: z.string().nullable(),
  })
  .openapi("FinanceStudentIdentity");

const getStudentRoute = createRoute({
  method: "get",
  path: "/api/finance/students/{studentId}",
  tags: ["Finance"],
  operationId: "getFinanceStudent",
  summary: "One student's identity and family, for their finance account page",
  description:
    "Identity only (name, admission number, enrolment status) and the family finance bills, so " +
    "finance staff, who cannot read student records, can open one student's account. Includes " +
    "withdrawn students, whose balance may still be owed.",
  security: [{ bearerAuth: [] }],
  request: { params: studentIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The student.", schema: studentIdentitySchema } },
    [401, 403, 404, 500],
  ),
});

export function financeStudentRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/finance/students", requirePermission(PERMISSIONS.BILLING_READ));
  routes.use("/api/finance/students/:studentId", requirePermission(PERMISSIONS.BILLING_READ));

  routes.openapi(searchStudentsRoute, async (c) => {
    const { schoolId } = requireAuth(c);
    const { search, limit } = c.req.valid("query");
    const students = await withStudentIdentityTx(database, schoolId, (tx) =>
      searchStudentIdentities(tx, schoolId, search, limit),
    );
    return c.json({ students }, 200);
  });

  routes.openapi(getStudentRoute, async (c) => {
    const { schoolId } = requireAuth(c);
    const { studentId } = c.req.valid("param");
    const student = await withStudentIdentityTx(database, schoolId, (tx) =>
      getStudentIdentity(tx, schoolId, studentId),
    );
    if (!student) {
      throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Student not found");
    }
    return c.json(student, 200);
  });

  return routes;
}
