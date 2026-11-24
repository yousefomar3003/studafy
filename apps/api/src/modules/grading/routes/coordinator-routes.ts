import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { onlyMethods } from "../../../middleware/only-methods";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import {
  coordinatorIdParamSchema,
  myCoordinatedSubjectsQuerySchema,
  myCoordinatedSubjectsSchema,
  subjectCoordinatorBodySchema,
  subjectCoordinatorListSchema,
  subjectCoordinatorSchema,
  subjectCoordinatorUpdateBodySchema,
} from "../coordinator-schemas";
import {
  createSubjectCoordinator,
  deleteSubjectCoordinator,
  getMyCoordinatedSubjects,
  listSubjectCoordinators,
  updateSubjectCoordinator,
} from "../coordinator-service";
import { yearIdParamSchema } from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

const TAGS = ["Academic grading"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const listRoute = createRoute({
  method: "get",
  path: "/api/grading/years/{yearId}/subject-coordinators",
  tags: TAGS,
  operationId: "listSubjectCoordinators",
  summary: "The year's subject coordinators",
  description:
    "Who coordinates which subject this year, and the grade levels each assignment covers (none: every grade level taught the subject).",
  security,
  request: { params: yearIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Coordinators.", schema: subjectCoordinatorListSchema } },
    [401, 403, 404, 500],
  ),
});

const createCoordinatorRoute = createRoute({
  method: "post",
  path: "/api/grading/years/{yearId}/subject-coordinators",
  tags: TAGS,
  operationId: "createSubjectCoordinator",
  summary: "Make a staff member a subject's coordinator for the year",
  description:
    "The coordinator then reads every section's marks, mark sheets, predicted grades and subject results for the subject in the grade levels covered, read-only. 400 VALIDATION_FAILED when the user is not school staff; 409 SUBJECT_COORDINATOR_DUPLICATE for a repeat.",
  security,
  request: { params: yearIdParamSchema, body: json(subjectCoordinatorBodySchema) },
  responses: standardResponses(
    { 201: { description: "Coordinator.", schema: subjectCoordinatorSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const updateCoordinatorRoute = createRoute({
  method: "patch",
  path: "/api/grading/subject-coordinators/{coordinatorId}",
  tags: TAGS,
  operationId: "updateSubjectCoordinator",
  summary: "Change the grade levels a subject coordinator covers",
  security,
  request: { params: coordinatorIdParamSchema, body: json(subjectCoordinatorUpdateBodySchema) },
  responses: standardResponses(
    { 200: { description: "Coordinator.", schema: subjectCoordinatorSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const deleteCoordinatorRoute = createRoute({
  method: "delete",
  path: "/api/grading/subject-coordinators/{coordinatorId}",
  tags: TAGS,
  operationId: "deleteSubjectCoordinator",
  summary: "Remove a subject coordinator",
  security,
  request: { params: coordinatorIdParamSchema },
  responses: {
    204: { description: "Removed.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
  },
});

const myCoordinatedRoute = createRoute({
  method: "get",
  path: "/api/grading/my-coordinated-subjects",
  tags: ["Marks"],
  operationId: "listMyCoordinatedSubjects",
  summary: "The subjects the current user coordinates, across their sections",
  description:
    "For the given year, or the latest active or finalized year: each subject's sections with their teachers, each period's mark sheet status, the current average from the marks recorded so far and the averages of finalized results. Empty for anyone who coordinates nothing. Open a section's marks read-only with getMarkSheet.",
  security,
  request: { query: myCoordinatedSubjectsQuerySchema },
  responses: standardResponses(
    { 200: { description: "Coordinated subjects.", schema: myCoordinatedSubjectsSchema } },
    [401, 403, 404, 500],
  ),
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

export function gradingCoordinatorRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const read = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_READ);
  const manage = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_MANAGE);

  routes.use(
    "/api/grading/years/:yearId/subject-coordinators",
    onlyMethods(["GET"], read),
    onlyMethods(["POST"], manage),
    auditAction("insert", "subject_coordinators"),
  );
  routes.use(
    "/api/grading/subject-coordinators/:coordinatorId",
    manage,
    onlyMethods(["PATCH"], auditAction("update", "subject_coordinators")),
    onlyMethods(["DELETE"], auditAction("delete", "subject_coordinators")),
  );
  // Like my-assignments: staff who read the grading configuration; the rows are the caller's own.
  routes.use("/api/grading/my-coordinated-subjects", read);

  routes.openapi(listRoute, async (c) => {
    const { yearId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const coordinators = await withTenantTx(database, tenant, (tx) =>
      listSubjectCoordinators(tx, tenant.schoolId, yearId),
    );
    return c.json({ coordinators }, 200);
  });

  routes.openapi(createCoordinatorRoute, async (c) => {
    const { yearId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        createSubjectCoordinator(tx, tenant.schoolId, yearId, body),
      ),
      201,
    );
  });

  routes.openapi(updateCoordinatorRoute, async (c) => {
    const { coordinatorId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateSubjectCoordinator(tx, tenant.schoolId, coordinatorId, body),
      ),
      200,
    );
  });

  routes.openapi(deleteCoordinatorRoute, async (c) => {
    const { coordinatorId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) =>
      deleteSubjectCoordinator(tx, tenant.schoolId, coordinatorId),
    );
    return c.body(null, 204);
  });

  routes.openapi(myCoordinatedRoute, async (c) => {
    const { academic_year_id } = c.req.valid("query");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getMyCoordinatedSubjects(tx, tenant.schoolId, tenant.userId, academic_year_id),
      ),
      200,
    );
  });

  return routes;
}
