import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import {
  createTeacherBodySchema,
  teacherIdParamSchema,
  teacherListQuerySchema,
  teacherListSchema,
  teacherProfileSchema,
  updateTeacherBodySchema,
} from "../schemas";
import {
  createTeacher as createTeacherService,
  getTeacher,
  getTeacherByUserId,
  listTeachers,
  updateTeacher as updateTeacherService,
} from "../teacher-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { TeacherProfile } from "../schemas";
import type { TeacherRow } from "../teacher-service";
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

function toDateStr(d: Date | null): string | null {
  return d !== null ? d.toISOString() : null;
}

function projectTeacher(row: TeacherRow): TeacherProfile {
  return {
    id: row.id,
    school_id: row.school_id,
    user_id: row.user_id,
    employee_number: row.employee_number,
    employment_status: row.employment_status,
    hire_date: toDateStr(row.hire_date),
    termination_date: toDateStr(row.termination_date),
    created_at: row.created_at as unknown as string,
    updated_at: row.updated_at as unknown as string,
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listTeachersRoute = createRoute({
  method: "get",
  path: "/api/teachers",
  tags: ["Teachers"],
  operationId: "listTeachers",
  summary: "List teachers",
  description:
    "Paginated, cursor-based list of teacher profiles for the authenticated school. Supports " +
    "search over employee number and filtering by employment status.",
  security: [{ bearerAuth: [] }],
  request: { query: teacherListQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of teachers.",
        schema: teacherListSchema,
      },
    },
    [400, 401, 403, 429, 500],
  ),
});

const getTeacherMeRoute = createRoute({
  method: "get",
  path: "/api/teachers/me",
  tags: ["Teachers"],
  operationId: "getTeacherMe",
  summary: "Get own teacher profile",
  description:
    "Returns the authenticated user's own teacher profile. Teachers with the INSTRUCTOR role " +
    "can view their own profile read-only without needing the TEACHER_READ permission.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    {
      200: {
        description: "The teacher profile.",
        schema: teacherProfileSchema,
      },
    },
    [401, 404, 500],
  ),
});

const getTeacherRoute = createRoute({
  method: "get",
  path: "/api/teachers/{teacherId}",
  tags: ["Teachers"],
  operationId: "getTeacher",
  summary: "Get a teacher profile",
  description: "Returns a single teacher profile by ID.",
  security: [{ bearerAuth: [] }],
  request: { params: teacherIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The teacher profile.",
        schema: teacherProfileSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const createTeacherRoute = createRoute({
  method: "post",
  path: "/api/teachers",
  tags: ["Teachers"],
  operationId: "createTeacher",
  summary: "Create a teacher",
  description:
    "Creates a new teacher with a linked user account and the INSTRUCTOR role. Fails with 409 " +
    "if the employee number already exists in this school.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createTeacherBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created teacher profile.",
        schema: teacherProfileSchema,
      },
    },
    [400, 401, 403, 409, 429, 500],
  ),
});

const updateTeacherRoute = createRoute({
  method: "patch",
  path: "/api/teachers/{teacherId}",
  tags: ["Teachers"],
  operationId: "updateTeacher",
  summary: "Update a teacher",
  description:
    "Partially updates a teacher profile. Fails with 409 if the new employee number conflicts. " +
    "Emits an audit log with the diff.",
  security: [{ bearerAuth: [] }],
  request: {
    params: teacherIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateTeacherBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated teacher profile.",
        schema: teacherProfileSchema,
      },
    },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function teacherRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // --- Channel guard: mutations restricted to web sessions ---
  const channelGuard = requireChannel(AUTH_CHANNELS.WEB);
  routes.use("/api/teachers", channelGuard);
  routes.use("/api/teachers/{teacherId}", channelGuard);

  // --- Permission guards ---
  // /api/teachers (list + create) — list requires READ, create requires CREATE
  routes.use("/api/teachers", requirePermission(PERMISSIONS.TEACHER_READ));
  routes.use("/api/teachers", requirePermission(PERMISSIONS.TEACHER_CREATE));
  // /api/teachers/{teacherId} (get + update) — get requires READ, update requires UPDATE
  routes.use("/api/teachers/{teacherId}", requirePermission(PERMISSIONS.TEACHER_READ));
  routes.use("/api/teachers/{teacherId}", requirePermission(PERMISSIONS.TEACHER_UPDATE));

  // --- Audit declarations ---
  routes.use("/api/teachers", auditAction("insert", "teachers"));
  routes.use("/api/teachers/{teacherId}", auditAction("update", "teachers"));

  // --- Handlers ---

  routes.openapi(listTeachersRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, next_cursor } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listTeachers(tx, auth.schoolId, {
        ...query,
        status: query.status,
      }),
    );

    const projected = rows.map(projectTeacher);
    return c.json({ teachers: projected, next_cursor }, 200);
  });

  routes.openapi(getTeacherMeRoute, async (c) => {
    const auth = requireAuth(c);

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getTeacherByUserId(tx, auth.schoolId, auth.userId),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Teacher profile not found" });
    }

    return c.json(projectTeacher(row), 200);
  });

  routes.openapi(getTeacherRoute, async (c) => {
    const auth = requireAuth(c);
    const { teacherId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getTeacher(tx, auth.schoolId, teacherId),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Teacher not found" });
    }

    return c.json(projectTeacher(row), 200);
  });

  routes.openapi(createTeacherRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createTeacherService(tx, auth.schoolId, body),
    );

    return c.json(projectTeacher(row), 201);
  });

  routes.openapi(updateTeacherRoute, async (c) => {
    const auth = requireAuth(c);
    const { teacherId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateTeacherService(tx, auth.schoolId, teacherId, body),
    );

    return c.json(projectTeacher(row), 200);
  });

  return routes;
}
