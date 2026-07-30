import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import {
  generateFeeScheduleBodySchema,
  installmentListSchema,
  installmentSchema,
  installmentsQuerySchema,
} from "./schemas";
import { generateFeeSchedule, listInstallments, type InstallmentRow } from "./service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { TenantErpNextFactory } from "../client/tenant-client";
import type { Context } from "hono";

const studentIdParamSchema = z
  .object({
    studentId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "studentId", in: "path" },
        description: "Local student UUID.",
      }),
  })
  .openapi("StudentIdParam");

type InstallmentResponse = z.infer<typeof installmentSchema>;

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function toResponse(row: InstallmentRow): InstallmentResponse {
  return { ...row, synced_at: row.synced_at } as InstallmentResponse;
}

const listInstallmentsRoute = createRoute({
  method: "get",
  path: "/api/finance/students/{studentId}/installments",
  tags: ["Finance"],
  operationId: "listStudentInstallments",
  summary: "List student fee schedule installments",
  description:
    "Returns paginated installments for a student from the local read-model cache. " +
    "ERPNext owns all balance computation; this is a projection for fast UI rendering. " +
    "The daily reconciliation job refreshes stale amounts and flags overdue items.",
  security: [{ bearerAuth: [] }],
  request: {
    params: studentIdParamSchema,
    query: installmentsQuerySchema,
  },
  responses: standardResponses(
    { 200: { description: "Paginated installments.", schema: installmentListSchema } },
    [400, 401, 403, 500],
  ),
});

const generateFeeScheduleRoute = createRoute({
  method: "post",
  path: "/api/finance/fee-schedules/generate",
  tags: ["Finance"],
  operationId: "generateFeeSchedule",
  summary: "Generate fee schedules from a fee structure",
  description:
    "Forwards fee schedule generation payloads to ERPNext for each student in the request. " +
    "Supports monthly, quarterly, term-wise, and yearly schedule types. " +
    "ERPNext computes per-installment amounts and assigns due dates; results are projected " +
    "into the local fee_schedule_cache read model. " +
    "ERPNext's own rejection messages are returned verbatim on 400.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: generateFeeScheduleBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "Created fee schedule installments.", schema: installmentListSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

export function installmentRoutes(
  database: Database,
  erpnextFactory: TenantErpNextFactory,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/finance/fee-schedules/generate", auditAction("insert", "fee_schedule_cache"));

  routes.use(
    "/api/finance/students/{studentId}/installments",
    requirePermission(PERMISSIONS.BILLING_READ),
  );
  routes.use("/api/finance/fee-schedules/generate", requirePermission(PERMISSIONS.BILLING_UPDATE));

  routes.openapi(listInstallmentsRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listInstallments(tx, auth.schoolId, studentId, {
        status: query.status,
        dueDateFrom: query.due_date_from,
        dueDateTo: query.due_date_to,
        limit: query.limit,
        offset: query.offset,
      }),
    );

    return c.json({ installments: rows.map(toResponse), total }, 200);
  });

  routes.openapi(generateFeeScheduleRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const acceptLanguage = c.req.header("Accept-Language");

    const rows = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const erpnext = await erpnextFactory.forSchool(tx, auth.schoolId);
      return generateFeeSchedule(
        tx,
        erpnext,
        auth.schoolId,
        {
          feeStructure: body.fee_structure,
          studentIds: body.student_ids,
          dueDates: body.due_dates,
          academicYearId: body.academic_year_id,
          program: body.program,
          scheduleType: body.schedule_type,
        },
        acceptLanguage,
      );
    });

    return c.json({ installments: rows.map(toResponse), total: rows.length }, 201);
  });

  return routes;
}
