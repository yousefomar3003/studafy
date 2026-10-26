import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";
import { uuidSchema } from "@studafy/shared-schemas";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction, emitAuditLog } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { onlyMethods } from "../../../middleware/only-methods";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { withStudentIdentityTx } from "../students/service";

import { feeStructureIdParamSchema } from "./schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { StudentIdentity } from "../students/service";
import type { TransactionSql } from "postgres";

const structureStudentListSchema = z
  .object({
    students: z.array(z.object({ id: uuidSchema, name: z.string(), admission_number: z.string() })),
  })
  .openapi("FeeStructureStudentList");

const replaceStructureStudentsBodySchema = z
  .object({
    student_ids: z.array(uuidSchema).max(5000).openapi({
      description: "The complete list; an empty array unties the structure from students.",
    }),
  })
  .openapi("ReplaceFeeStructureStudentsBody");

const getStructureStudentsRoute = createRoute({
  method: "get",
  path: "/api/finance/fee-structures/{feeStructureId}/students",
  tags: ["Finance"],
  operationId: "listFeeStructureStudents",
  summary: "List the students a fee structure is for",
  description:
    "Identity only (id, name, admission number). Empty when the structure is not tied to " +
    "particular students.",
  security: [{ bearerAuth: [] }],
  request: { params: feeStructureIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The structure's students.", schema: structureStudentListSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const putStructureStudentsRoute = createRoute({
  method: "put",
  path: "/api/finance/fee-structures/{feeStructureId}/students",
  tags: ["Finance"],
  operationId: "replaceFeeStructureStudents",
  summary: "Set the students a fee structure is for",
  description:
    "Replaces the whole list. Kept in Studafy, not ERPNext, so it can change even after the " +
    "structure is submitted. Generating invoices for the structure preselects these students. " +
    "Withdrawn students and students of another school are refused.",
  security: [{ bearerAuth: [] }],
  request: {
    params: feeStructureIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: replaceStructureStudentsBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The structure's students.", schema: structureStudentListSchema } },
    [400, 401, 403, 404, 500],
  ),
});

/** The structure's cache row id (the audit target); 404 when the school has no such structure. */
async function assertStructureExists(
  tx: TransactionSql,
  schoolId: string,
  name: string,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    SELECT id FROM app.fee_structure_cache
    WHERE school_id = ${schoolId}::uuid AND erpnext_docname = ${name}
  `;
  if (!row) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.FEE_STRUCTURE_NOT_FOUND,
      `Fee structure ${name} not found`,
    );
  }
  return row.id;
}

/** Runs in a student identity transaction (see ../students/service.ts). */
async function listStructureStudents(
  tx: TransactionSql,
  schoolId: string,
  name: string,
): Promise<StudentIdentity[]> {
  await assertStructureExists(tx, schoolId, name);
  return tx<StudentIdentity[]>`
    SELECT s.id, coalesce(s.preferred_name, s.first_name) || ' ' || s.last_name AS name,
           s.admission_number
    FROM app.fee_structure_students AS fss
    JOIN app.students AS s ON s.id = fss.student_id AND s.school_id = fss.school_id
    WHERE fss.school_id = ${schoolId}::uuid AND fss.fee_structure_erpnext_name = ${name}
    ORDER BY s.last_name, s.first_name, s.id
  `;
}

export function feeStructureStudentRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(
    "/api/finance/fee-structures/:feeStructureId/students",
    onlyMethods(["PUT"], auditAction("update", "fee_structure_students")),
  );
  routes.use(
    "/api/finance/fee-structures/:feeStructureId/students",
    requirePermission(PERMISSIONS.BILLING_READ),
  );
  routes.use(
    "/api/finance/fee-structures/:feeStructureId/students",
    onlyMethods(["PUT"], requirePermission(PERMISSIONS.BILLING_UPDATE)),
  );

  routes.openapi(getStructureStudentsRoute, async (c) => {
    const { schoolId } = requireAuth(c);
    const { feeStructureId } = c.req.valid("param");
    const students = await withStudentIdentityTx(database, schoolId, (tx) =>
      listStructureStudents(tx, schoolId, feeStructureId),
    );
    return c.json({ students }, 200);
  });

  routes.openapi(putStructureStudentsRoute, async (c) => {
    const auth = requireAuth(c);
    const { feeStructureId } = c.req.valid("param");
    const studentIds = [...new Set(c.req.valid("json").student_ids)];

    // Checked through the identity read: a FINANCE caller cannot see app.students itself.
    const valid = await withStudentIdentityTx(database, auth.schoolId, (tx) =>
      studentIds.length === 0
        ? Promise.resolve([] as { id: string }[])
        : tx<{ id: string }[]>`
            SELECT id FROM app.students
            WHERE school_id = ${auth.schoolId}::uuid
              AND status <> 'withdrawn'
              AND id = ANY(${studentIds}::uuid[])
          `,
    );
    if (valid.length !== studentIds.length) {
      const found = new Set(valid.map((row) => row.id));
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `Not current students of this school: ${studentIds.filter((id) => !found.has(id)).join(", ")}`,
      );
    }

    const tenant = { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
    await withTenantTx(database, tenant, async (tx) => {
      const structureId = await assertStructureExists(tx, auth.schoolId, feeStructureId);
      const removed = await tx<{ student_id: string }[]>`
        DELETE FROM app.fee_structure_students
        WHERE school_id = ${auth.schoolId}::uuid AND fee_structure_erpnext_name = ${feeStructureId}
        RETURNING student_id
      `;
      if (studentIds.length > 0) {
        await tx`
          INSERT INTO app.fee_structure_students
            (school_id, fee_structure_erpnext_name, student_id, created_by)
          SELECT ${auth.schoolId}::uuid, ${feeStructureId}, student_id, ${auth.userId}::uuid
          FROM unnest(${studentIds}::uuid[]) AS student_id
        `;
      }
      await emitAuditLog(tx, {
        action: "update",
        targetTable: "fee_structure_students",
        targetId: structureId,
        oldValues: {
          fee_structure: feeStructureId,
          student_ids: removed.map((row) => row.student_id).sort(),
        },
        newValues: { fee_structure: feeStructureId, student_ids: [...studentIds].sort() },
      });
    });

    const students = await withStudentIdentityTx(database, auth.schoolId, (tx) =>
      listStructureStudents(tx, auth.schoolId, feeStructureId),
    );
    return c.json({ students }, 200);
  });

  return routes;
}
