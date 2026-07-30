import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS, ROLES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import { loadPublishedGradeSnapshotCached } from "./cache";
import { publishedGradeParamsSchema, publishedGradeSnapshotSchema } from "./schemas";
import { assertPublishedGradeAccess, assertTermExists, getPublishedGradeSnapshot } from "./service";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type { Context } from "hono";

const getPublishedGradesRoute = createRoute({
  method: "get",
  path: "/api/grades/published/students/{studentId}/terms/{termId}",
  tags: ["Published Grades"],
  operationId: "getPublishedGrades",
  summary: "Get a student's published grades for a term",
  description:
    "Returns only published gradebook records, a credit-weighted term summary, and cumulative " +
    "GPA through the requested term. Students may request only themselves; parents may request " +
    "only children linked through parent_child_links.",
  security: [{ bearerAuth: [] }],
  request: { params: publishedGradeParamsSchema },
  responses: standardResponses(
    {
      200: {
        description: "Published grades and calculated summaries.",
        schema: publishedGradeSnapshotSchema,
      },
    },
    [401, 403, 404, 500],
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

export function publishedGradeRoutes(
  database: Database,
  redis: RedisClient | null,
  logger: Logger,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(
    "/api/grades/published/students/{studentId}/terms/{termId}",
    requirePermission(PERMISSIONS.GRADE_READ),
  );

  routes.openapi(getPublishedGradesRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId, termId } = c.req.valid("param");
    const isStudentOrParent =
      auth.roles.includes(ROLES.STUDENT) || auth.roles.includes(ROLES.PARENT);

    if (!isStudentOrParent) {
      throw new CodedHttpException(403, ERROR_CODES.ACCESS_DENIED, "Access denied");
    }

    const loadAuthorized = () =>
      withTenantTx(database, tenantFrom(c), async (tx) => {
        await assertPublishedGradeAccess(tx, auth.schoolId, studentId);
        await assertTermExists(tx, auth.schoolId, termId);
        return getPublishedGradeSnapshot(tx, auth.schoolId, studentId, termId);
      });

    let snapshot;
    if (redis) {
      // Authorization is deliberately checked before a cache lookup: a removed parent link must
      // take effect immediately and a shared student cache must never become an authorization
      // mechanism.
      await withTenantTx(database, tenantFrom(c), async (tx) => {
        await assertPublishedGradeAccess(tx, auth.schoolId, studentId);
        await assertTermExists(tx, auth.schoolId, termId);
      });
      snapshot = await loadPublishedGradeSnapshotCached({
        redis,
        logger,
        schoolId: auth.schoolId,
        studentId,
        termId,
        load: loadAuthorized,
      });
    } else {
      snapshot = await loadAuthorized();
    }

    return c.json(snapshot, 200);
  });

  return routes;
}
