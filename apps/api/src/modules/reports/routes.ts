import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ReportFilterError,
  ReportResourceNotFoundError,
  resolveReportFilter,
} from "@studafy/attendance-reporting";
import { ERROR_CODES, PERMISSIONS, ROLES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { withTenantTx } from "../../db/tenant-tx";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";

import {
  childBreakdownParamsSchema,
  childBreakdownResponseSchema,
  childComparisonQuerySchema,
  childComparisonResponseSchema,
} from "./schemas";
import {
  assertChildLinked,
  collectChildBreakdown,
  collectChildComparison,
  listLinkedChildren,
} from "./service";

import type { Database, DatabasePools } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

const comparisonRoute = createRoute({
  method: "get",
  path: "/api/reports/children/comparison",
  tags: ["Child Comparison Reports"],
  operationId: "getChildrenComparison",
  summary: "Compare linked children's grades, attendance, and assignments for a term",
  description:
    "Returns per-child grade snapshot and trend, attendance metrics, and assignment completion " +
    "for every child linked to the calling parent, all scoped to one term. Parents may read only " +
    "children linked through app.parent_child_links.",
  security: [{ bearerAuth: [] }],
  request: { query: childComparisonQuerySchema },
  responses: standardResponses(
    {
      200: { description: "Per-child comparison metrics.", schema: childComparisonResponseSchema },
    },
    [400, 401, 403, 404, 500],
  ),
});

const breakdownRoute = createRoute({
  method: "get",
  path: "/api/reports/children/{studentId}/breakdown",
  tags: ["Child Comparison Reports"],
  operationId: "getChildComparisonBreakdown",
  summary: "Get one linked child's comparison breakdown for a term",
  description:
    "The per-child detail behind the comparison screen: identity, grade trend, per-course " +
    "published grades with the term summary, attendance totals and trend, and assignment " +
    "completion. The child must be linked to the calling parent.",
  security: [{ bearerAuth: [] }],
  request: {
    params: childBreakdownParamsSchema,
    query: childComparisonQuerySchema,
  },
  responses: standardResponses(
    { 200: { description: "Per-child breakdown.", schema: childBreakdownResponseSchema } },
    [400, 401, 403, 404, 500],
  ),
});

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function translateReportError(error: unknown): never {
  if (error instanceof ReportResourceNotFoundError) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.ATTENDANCE_REPORT_RESOURCE_NOT_FOUND,
      error.message,
    );
  }
  if (error instanceof ReportFilterError) {
    throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, error.message);
  }
  throw error;
}

/**
 * Parent child-comparison report routes (ST-177).
 *
 * Both routes gate on GRADE_READ — the same permission the published grades parent view uses — and
 * additionally require the PARENT role so a staff member with grade access cannot enumerate
 * children. Every metric is then resolved inside a read-replica transaction whose RLS scope is the
 * caller's own tenant and link set, and the breakdown route asserts the requested child is linked
 * before touching any grade or attendance data.
 */
export function childComparisonRoutes(
  primary: Database,
  readReplica: Database,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const databases: DatabasePools = { primary, readReplica };

  routes.use(comparisonRoute.path, requirePermission(PERMISSIONS.GRADE_READ));
  routes.use(breakdownRoute.path, requirePermission(PERMISSIONS.GRADE_READ));

  routes.openapi(comparisonRoute, async (c) => {
    const auth = requireAuth(c);
    if (!auth.roles.includes(ROLES.PARENT)) {
      throw new CodedHttpException(403, ERROR_CODES.ACCESS_DENIED, "Access denied");
    }
    const { term_id } = c.req.valid("query");
    try {
      const result = await withTenantTx(
        databases,
        tenantFrom(c),
        async (tx) => {
          const filter = await resolveReportFilter(tx, auth.schoolId, { termId: term_id });
          const children = await listLinkedChildren(tx, auth.schoolId, auth.userId);
          const metrics = await Promise.all(
            children.map((child) =>
              collectChildComparison(tx, auth.schoolId, child.student_id, term_id, filter),
            ),
          );
          return { filter, children, metrics };
        },
        { useReadReplica: true },
      );
      return c.json(
        {
          generated_at: new Date().toISOString(),
          period: {
            term_id: result.filter.termId,
            start_date: result.filter.startDate,
            end_date: result.filter.endDate,
          },
          children: result.children.map((child, index) => {
            const metrics = result.metrics[index];
            return {
              student_id: child.student_id,
              student_name: child.student_name,
              admission_number: child.admission_number,
              ...metrics,
            };
          }),
        },
        200,
      );
    } catch (error) {
      return translateReportError(error);
    }
  });

  routes.openapi(breakdownRoute, async (c) => {
    const auth = requireAuth(c);
    if (!auth.roles.includes(ROLES.PARENT)) {
      throw new CodedHttpException(403, ERROR_CODES.ACCESS_DENIED, "Access denied");
    }
    const { studentId } = c.req.valid("param");
    const { term_id } = c.req.valid("query");
    try {
      const result = await withTenantTx(
        databases,
        tenantFrom(c),
        async (tx) => {
          await assertChildLinked(tx, auth.schoolId, auth.userId, studentId);
          const filter = await resolveReportFilter(tx, auth.schoolId, { termId: term_id });
          const breakdown = await collectChildBreakdown(
            tx,
            auth.schoolId,
            studentId,
            term_id,
            filter,
          );
          return { filter, breakdown };
        },
        { useReadReplica: true },
      );
      return c.json(
        {
          generated_at: new Date().toISOString(),
          period: {
            term_id: result.filter.termId,
            start_date: result.filter.startDate,
            end_date: result.filter.endDate,
          },
          ...result.breakdown,
        },
        200,
      );
    } catch (error) {
      return translateReportError(error);
    }
  });

  return routes;
}
