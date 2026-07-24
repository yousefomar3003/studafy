import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { hasPermission, requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import {
  createStudentBodySchema,
  guardianSchema,
  studentIdParamSchema,
  studentListQuerySchema,
  studentListSchema,
  studentProfileSchema,
  updateStudentBodySchema,
} from "../schemas";
import {
  createStudent as createStudentService,
  getStudent,
  getStudentGuardians,
  listStudents,
  updateStudent as updateStudentService,
} from "../student-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { StudentProfile } from "../schemas";
import type { StudentRow } from "../student-service";
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

/**
 * Project a student row to the caller's permitted field set.
 *
 * Finance-visible roles (those with BILLING_READ) receive the full profile including admission
 * data. All others receive demographics only — name, DOB, nationality, status, and metadata.
 */
function projectStudent(row: StudentRow, c: Context<AppEnv>): StudentProfile {
  const auth = requireAuth(c);
  const hasBillingRead = hasPermission(auth.roles, PERMISSIONS.BILLING_READ);

  const base = {
    id: row.id,
    school_id: row.school_id,
    user_id: row.user_id,
    first_name: row.first_name,
    middle_name: row.middle_name,
    last_name: row.last_name,
    preferred_name: row.preferred_name,
    date_of_birth: toDateStr(row.date_of_birth),
    nationality_country_id: row.nationality_country_id,
    status: row.status,
    created_at: row.created_at as unknown as string,
    updated_at: row.updated_at as unknown as string,
  };

  if (hasBillingRead) {
    return {
      ...base,
      admission_number: row.admission_number,
      admission_date: toDateStr(row.admission_date),
    } satisfies StudentProfile;
  }

  // Non-finance roles: strip admission fields from the response.
  return {
    ...base,
    admission_number: "",
    admission_date: null,
  } satisfies StudentProfile;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listStudentsRoute = createRoute({
  method: "get",
  path: "/api/students",
  tags: ["Students"],
  operationId: "listStudents",
  summary: "List students",
  description:
    "Paginated, cursor-based list of students for the authenticated school. Supports search " +
    "over name and admission number, filtering by status, and date-range filtering.",
  security: [{ bearerAuth: [] }],
  request: { query: studentListQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of students.",
        schema: studentListSchema,
      },
    },
    [400, 401, 403, 429, 500],
  ),
});

const getStudentRoute = createRoute({
  method: "get",
  path: "/api/students/{studentId}",
  tags: ["Students"],
  operationId: "getStudent",
  summary: "Get a student profile",
  description:
    "Returns a single student profile. Roles with billing permissions receive the full profile " +
    "including admission data; others receive demographics only.",
  security: [{ bearerAuth: [] }],
  request: { params: studentIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The student profile.",
        schema: studentProfileSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const createStudentRoute = createRoute({
  method: "post",
  path: "/api/students",
  tags: ["Students"],
  operationId: "createStudent",
  summary: "Create a student",
  description:
    "Creates a new student with a linked user account and the STUDENT role. Fails with 409 if " +
    "the admission number already exists in this school.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createStudentBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created student profile.",
        schema: studentProfileSchema,
      },
    },
    [400, 401, 403, 409, 429, 500],
  ),
});

const updateStudentRoute = createRoute({
  method: "patch",
  path: "/api/students/{studentId}",
  tags: ["Students"],
  operationId: "updateStudent",
  summary: "Update a student",
  description:
    "Partially updates a student profile. Fails with 409 if the new admission number conflicts. " +
    "Emits an audit log with the diff.",
  security: [{ bearerAuth: [] }],
  request: {
    params: studentIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateStudentBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated student profile.",
        schema: studentProfileSchema,
      },
    },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

const listGuardiansRoute = createRoute({
  method: "get",
  path: "/api/students/{studentId}/guardians",
  tags: ["Students"],
  operationId: "listStudentGuardians",
  summary: "List student guardians",
  description: "Returns the guardian links for a student.",
  security: [{ bearerAuth: [] }],
  request: { params: studentIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "List of guardian links.",
        schema: guardianSchema.array(),
      },
    },
    [401, 403, 404, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function studentRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // --- Channel guard: mutations restricted to web sessions ---
  const channelGuard = requireChannel(AUTH_CHANNELS.WEB);
  routes.use("/api/students", channelGuard);
  routes.use("/api/students/{studentId}", channelGuard);

  // --- Permission guards ---
  routes.use("/api/students", requirePermission(PERMISSIONS.STUDENT_READ));
  routes.use("/api/students", requirePermission(PERMISSIONS.STUDENT_CREATE));
  routes.use("/api/students/{studentId}", requirePermission(PERMISSIONS.STUDENT_READ));
  routes.use("/api/students/{studentId}", requirePermission(PERMISSIONS.STUDENT_UPDATE));
  routes.use("/api/students/{studentId}/guardians", requirePermission(PERMISSIONS.STUDENT_READ));

  // --- Audit declarations ---
  routes.use("/api/students", auditAction("insert", "students"));
  routes.use("/api/students/{studentId}", auditAction("update", "students"));

  // --- Handlers ---

  routes.openapi(listStudentsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, next_cursor } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listStudents(tx, auth.schoolId, {
        ...query,
        status: query.status,
      }),
    );

    const projected = rows.map((row) => projectStudent(row, c));
    return c.json({ students: projected, next_cursor }, 200);
  });

  routes.openapi(getStudentRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getStudent(tx, auth.schoolId, studentId),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Student not found" });
    }

    return c.json(projectStudent(row, c), 200);
  });

  routes.openapi(createStudentRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createStudentService(tx, auth.schoolId, body),
    );

    return c.json(projectStudent(row, c), 201);
  });

  routes.openapi(updateStudentRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateStudentService(tx, auth.schoolId, studentId, body),
    );

    return c.json(projectStudent(row, c), 200);
  });

  routes.openapi(listGuardiansRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");

    // Verify the student exists (RLS handles visibility scoping).
    const student = await withTenantTx(database, tenantFrom(c), (tx) =>
      getStudent(tx, auth.schoolId, studentId),
    );

    if (!student) {
      throw new HTTPException(404, { message: "Student not found" });
    }

    const guardians = await withTenantTx(database, tenantFrom(c), (tx) =>
      getStudentGuardians(tx, auth.schoolId, studentId),
    );

    return c.json(guardians, 200);
  });

  return routes;
}
