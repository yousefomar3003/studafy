import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { onlyMethods } from "../../../middleware/only-methods";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import {
  createGradeLevelBodySchema,
  createSectionBodySchema,
  gradeLevelIdParamSchema,
  gradeLevelListSchema,
  gradeLevelSchema,
  placeSectionStudentBodySchema,
  sectionIdParamSchema,
  sectionListSchema,
  sectionPlacementResultSchema,
  sectionQuerySchema,
  sectionSchema,
  sectionStudentListSchema,
  studentIdParamSchema,
  updateGradeLevelBodySchema,
  updateSectionBodySchema,
} from "../schemas";
import {
  createGradeLevel,
  createSection,
  deleteGradeLevel,
  deleteSection,
  getSection,
  listGradeLevels,
  listSectionStudents,
  listSections,
  placeStudentInSection,
  removeStudentFromSection,
  updateGradeLevel,
  updateSection,
} from "../section-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Route definitions — Grade levels
// ---------------------------------------------------------------------------

const listGradeLevelsRoute = createRoute({
  method: "get",
  path: "/api/academics/grade-levels",
  tags: ["Academics"],
  operationId: "listGradeLevels",
  summary: "List grade levels",
  description: "The school's grades (year groups), ordered by sort order.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The school's grade levels.", schema: gradeLevelListSchema } },
    [401, 500],
  ),
});

const createGradeLevelRoute = createRoute({
  method: "post",
  path: "/api/academics/grade-levels",
  tags: ["Academics"],
  operationId: "createGradeLevel",
  summary: "Create a grade level",
  description: "Adds a grade (year group), e.g. 'Grade 10'. Names are unique within the school.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createGradeLevelBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The created grade level.", schema: gradeLevelSchema } },
    [400, 401, 403, 409, 500],
  ),
});

const updateGradeLevelRoute = createRoute({
  method: "patch",
  path: "/api/academics/grade-levels/{gradeLevelId}",
  tags: ["Academics"],
  operationId: "updateGradeLevel",
  summary: "Update a grade level",
  description: "Renames or reorders a grade.",
  security: [{ bearerAuth: [] }],
  request: {
    params: gradeLevelIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateGradeLevelBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The updated grade level.", schema: gradeLevelSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteGradeLevelRoute = createRoute({
  method: "delete",
  path: "/api/academics/grade-levels/{gradeLevelId}",
  tags: ["Academics"],
  operationId: "deleteGradeLevel",
  summary: "Delete a grade level",
  description: "Deletes a grade that has no sections; 409 GRADE_LEVEL_HAS_SECTIONS otherwise.",
  security: [{ bearerAuth: [] }],
  request: { params: gradeLevelIdParamSchema },
  responses: {
    204: { description: "Grade level deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 500]),
  },
});

// ---------------------------------------------------------------------------
// Route definitions — Sections
// ---------------------------------------------------------------------------

const listSectionsRoute = createRoute({
  method: "get",
  path: "/api/academics/sections",
  tags: ["Academics"],
  operationId: "listSections",
  summary: "List sections",
  description:
    "Sections, optionally of one academic year and/or grade, ordered by grade then name.",
  security: [{ bearerAuth: [] }],
  request: { query: sectionQuerySchema },
  responses: standardResponses(
    { 200: { description: "Paginated list of sections.", schema: sectionListSchema } },
    [401, 500],
  ),
});

const createSectionRoute = createRoute({
  method: "post",
  path: "/api/academics/sections",
  tags: ["Academics"],
  operationId: "createSection",
  summary: "Create a section",
  description: "Adds a section (e.g. 'C') to a grade for one academic year.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createSectionBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The created section.", schema: sectionSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const getSectionRoute = createRoute({
  method: "get",
  path: "/api/academics/sections/{sectionId}",
  tags: ["Academics"],
  operationId: "getSection",
  summary: "Get a section",
  description: "Returns a single section by ID.",
  security: [{ bearerAuth: [] }],
  request: { params: sectionIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The section.", schema: sectionSchema } },
    [401, 404, 500],
  ),
});

const updateSectionRoute = createRoute({
  method: "patch",
  path: "/api/academics/sections/{sectionId}",
  tags: ["Academics"],
  operationId: "updateSection",
  summary: "Rename or archive a section",
  description: "Renames a section within its grade, or archives or restores it.",
  security: [{ bearerAuth: [] }],
  request: {
    params: sectionIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateSectionBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The updated section.", schema: sectionSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteSectionRoute = createRoute({
  method: "delete",
  path: "/api/academics/sections/{sectionId}",
  tags: ["Academics"],
  operationId: "deleteSection",
  summary: "Delete a section",
  description: "Deletes a section with no classes or students; 409 SECTION_IN_USE otherwise.",
  security: [{ bearerAuth: [] }],
  request: { params: sectionIdParamSchema },
  responses: {
    204: { description: "Section deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 500]),
  },
});

// ---------------------------------------------------------------------------
// Route definitions — Student placement
// ---------------------------------------------------------------------------

const listSectionStudentsRoute = createRoute({
  method: "get",
  path: "/api/academics/sections/{sectionId}/students",
  tags: ["Academics"],
  operationId: "listSectionStudents",
  summary: "List a section's students",
  description: "Students placed in the section, ordered by last name.",
  security: [{ bearerAuth: [] }],
  request: { params: sectionIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The section's students.", schema: sectionStudentListSchema } },
    [401, 403, 404, 500],
  ),
});

const placeSectionStudentRoute = createRoute({
  method: "post",
  path: "/api/academics/sections/{sectionId}/students",
  tags: ["Academics"],
  operationId: "placeSectionStudent",
  summary: "Place a student in a section",
  description:
    "Places the student in the section for its academic year and enrolls them into the " +
    "section's planned and active classes. A student already in another section of that year " +
    "is moved, and withdrawn from the old section's classes. Classes at capacity are skipped " +
    "and listed in skipped_class_ids.",
  security: [{ bearerAuth: [] }],
  request: {
    params: sectionIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: placeSectionStudentBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The placement.", schema: sectionPlacementResultSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const removeSectionStudentRoute = createRoute({
  method: "delete",
  path: "/api/academics/sections/{sectionId}/students/{studentId}",
  tags: ["Academics"],
  operationId: "removeSectionStudent",
  summary: "Remove a student from a section",
  description: "Removes the placement and withdraws the student from the section's classes.",
  security: [{ bearerAuth: [] }],
  request: { params: sectionIdParamSchema.merge(studentIdParamSchema) },
  responses: {
    204: { description: "Student removed from the section.", headers: requestIdHeaders },
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

export function sectionRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Grades and sections are the timetable's structure, so writes need timetable:manage (ORG_ADMIN,
  // PRINCIPAL). Reading the names stays open to every school member: apps label lessons "10-C".
  // A section's student list is personal data and also needs timetable:manage.
  const manage = requirePermission(PERMISSIONS.TIMETABLE_MANAGE);
  routes.use("/api/academics/grade-levels", onlyMethods(["POST"], manage));
  routes.use("/api/academics/grade-levels/:gradeLevelId", onlyMethods(["PATCH", "DELETE"], manage));
  routes.use("/api/academics/sections", onlyMethods(["POST"], manage));
  routes.use("/api/academics/sections/:sectionId", onlyMethods(["PATCH", "DELETE"], manage));
  routes.use("/api/academics/sections/:sectionId/students", manage);
  routes.use("/api/academics/sections/:sectionId/students/:studentId", manage);

  // Audit declarations
  routes.use("/api/academics/grade-levels", auditAction("insert", "grade_levels"));
  routes.use("/api/academics/grade-levels/:gradeLevelId", auditAction("update", "grade_levels"));
  routes.use("/api/academics/sections", auditAction("insert", "sections"));
  routes.use("/api/academics/sections/:sectionId", auditAction("update", "sections"));
  routes.use(
    "/api/academics/sections/:sectionId/students",
    auditAction("insert", "student_sections"),
  );
  routes.use(
    "/api/academics/sections/:sectionId/students/:studentId",
    auditAction("delete", "student_sections"),
  );

  // --- Grade levels ---

  routes.openapi(listGradeLevelsRoute, async (c) => {
    const auth = requireAuth(c);
    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listGradeLevels(tx, auth.schoolId),
    );
    return c.json({ grade_levels: rows, total }, 200);
  });

  routes.openapi(createGradeLevelRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createGradeLevel(tx, auth.schoolId, body),
    );
    return c.json(row, 201);
  });

  routes.openapi(updateGradeLevelRoute, async (c) => {
    const auth = requireAuth(c);
    const { gradeLevelId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateGradeLevel(tx, auth.schoolId, gradeLevelId, body),
    );
    return c.json(row, 200);
  });

  routes.openapi(deleteGradeLevelRoute, async (c) => {
    const auth = requireAuth(c);
    const { gradeLevelId } = c.req.valid("param");
    await withTenantTx(database, tenantFrom(c), (tx) =>
      deleteGradeLevel(tx, auth.schoolId, gradeLevelId),
    );
    return c.body(null, 204);
  });

  // --- Sections ---

  routes.openapi(listSectionsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");
    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listSections(tx, auth.schoolId, query),
    );
    return c.json({ sections: rows, total }, 200);
  });

  routes.openapi(createSectionRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createSection(tx, auth.schoolId, body),
    );
    return c.json(row, 201);
  });

  routes.openapi(getSectionRoute, async (c) => {
    const auth = requireAuth(c);
    const { sectionId } = c.req.valid("param");
    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getSection(tx, auth.schoolId, sectionId),
    );
    if (!row) {
      throw new HTTPException(404, { message: "Section not found" });
    }
    return c.json(row, 200);
  });

  routes.openapi(updateSectionRoute, async (c) => {
    const auth = requireAuth(c);
    const { sectionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateSection(tx, auth.schoolId, sectionId, body),
    );
    return c.json(row, 200);
  });

  routes.openapi(deleteSectionRoute, async (c) => {
    const auth = requireAuth(c);
    const { sectionId } = c.req.valid("param");
    await withTenantTx(database, tenantFrom(c), (tx) =>
      deleteSection(tx, auth.schoolId, sectionId),
    );
    return c.body(null, 204);
  });

  // --- Student placement ---

  routes.openapi(listSectionStudentsRoute, async (c) => {
    const auth = requireAuth(c);
    const { sectionId } = c.req.valid("param");
    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listSectionStudents(tx, auth.schoolId, sectionId),
    );
    return c.json({ students: rows, total }, 200);
  });

  routes.openapi(placeSectionStudentRoute, async (c) => {
    const auth = requireAuth(c);
    const { sectionId } = c.req.valid("param");
    const { student_id } = c.req.valid("json");
    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      placeStudentInSection(tx, auth.schoolId, sectionId, student_id),
    );
    return c.json(result, 200);
  });

  routes.openapi(removeSectionStudentRoute, async (c) => {
    const auth = requireAuth(c);
    const { sectionId, studentId } = c.req.valid("param");
    await withTenantTx(database, tenantFrom(c), (tx) =>
      removeStudentFromSection(tx, auth.schoolId, sectionId, studentId),
    );
    return c.body(null, 204);
  });

  return routes;
}
