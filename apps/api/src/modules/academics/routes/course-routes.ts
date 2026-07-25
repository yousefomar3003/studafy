import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import {
  createCourse,
  deleteCourse,
  getCourse,
  listCourses,
  updateCourse,
} from "../course-service";
import {
  courseIdParamSchema,
  courseListSchema,
  courseQuerySchema,
  courseSchema,
  createCourseBodySchema,
  subjectIdParamSchema,
  updateCourseBodySchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listCoursesRoute = createRoute({
  method: "get",
  path: "/api/academics/subjects/{subjectId}/courses",
  tags: ["Academics"],
  operationId: "listCourses",
  summary: "List courses for a subject",
  description: "Paginated list of courses belonging to the specified subject.",
  security: [{ bearerAuth: [] }],
  request: {
    params: subjectIdParamSchema,
    query: courseQuerySchema,
  },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of courses.",
        schema: courseListSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const createCourseRoute = createRoute({
  method: "post",
  path: "/api/academics/subjects/{subjectId}/courses",
  tags: ["Academics"],
  operationId: "createCourse",
  summary: "Create a course",
  description: "Creates a new course under the specified subject.",
  security: [{ bearerAuth: [] }],
  request: {
    params: subjectIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: createCourseBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created course.",
        schema: courseSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const getCourseRoute = createRoute({
  method: "get",
  path: "/api/academics/courses/{courseId}",
  tags: ["Academics"],
  operationId: "getCourse",
  summary: "Get a course",
  description: "Returns a single course by ID.",
  security: [{ bearerAuth: [] }],
  request: { params: courseIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The course.",
        schema: courseSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const updateCourseRoute = createRoute({
  method: "patch",
  path: "/api/academics/courses/{courseId}",
  tags: ["Academics"],
  operationId: "updateCourse",
  summary: "Update a course",
  description: "Partially updates a course.",
  security: [{ bearerAuth: [] }],
  request: {
    params: courseIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateCourseBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated course.",
        schema: courseSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteCourseRoute = createRoute({
  method: "delete",
  path: "/api/academics/courses/{courseId}",
  tags: ["Academics"],
  operationId: "deleteCourse",
  summary: "Delete a course",
  description:
    "Deletes a course. If the course has dependent classes it is archived instead. " +
    "Unreferenced courses are hard-deleted.",
  security: [{ bearerAuth: [] }],
  request: { params: courseIdParamSchema },
  responses: {
    204: { description: "Course deleted or archived.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
  },
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

export function courseRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Audit declarations
  routes.use("/api/academics/subjects/{subjectId}/courses", auditAction("insert", "courses"));
  routes.use("/api/academics/courses/{courseId}", auditAction("update", "courses"));

  routes.openapi(listCoursesRoute, async (c) => {
    const auth = requireAuth(c);
    const { subjectId } = c.req.valid("param");
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listCourses(tx, auth.schoolId, subjectId, query),
    );

    return c.json({ courses: rows, total }, 200);
  });

  routes.openapi(createCourseRoute, async (c) => {
    const auth = requireAuth(c);
    const { subjectId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createCourse(tx, auth.schoolId, { ...body, subject_id: subjectId }),
    );

    return c.json(row, 201);
  });

  routes.openapi(getCourseRoute, async (c) => {
    const auth = requireAuth(c);
    const { courseId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getCourse(tx, auth.schoolId, courseId),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Course not found" });
    }

    return c.json(row, 200);
  });

  routes.openapi(updateCourseRoute, async (c) => {
    const auth = requireAuth(c);
    const { courseId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateCourse(tx, auth.schoolId, courseId, body),
    );

    return c.json(row, 200);
  });

  routes.openapi(deleteCourseRoute, async (c) => {
    const auth = requireAuth(c);
    const { courseId } = c.req.valid("param");

    await withTenantTx(database, tenantFrom(c), (tx) => deleteCourse(tx, auth.schoolId, courseId));

    return new Response(null, { status: 204 });
  });

  return routes;
}
