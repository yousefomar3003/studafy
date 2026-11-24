import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../db/tenant-tx";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { onlyMethods } from "../../middleware/only-methods";
import { openApiValidationHook } from "../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../openapi/responses";

import {
  examClashListSchema,
  examInvigilatorsBodySchema,
  examPeriodBodySchema,
  examPeriodIdParamSchema,
  examPeriodListQuerySchema,
  examPeriodListSchema,
  examPeriodSchema,
  examPeriodSeatingSchema,
  examSeatBodySchema,
  examSeatingBodySchema,
  examSeatingResultSchema,
  examSeatParamSchema,
  examSlotBodySchema,
  examSlotIdParamSchema,
  examSlotSchema,
  examSlotSeatingSchema,
  examStudentParamSchema,
  invigilationDutyListSchema,
  studentExamTimetableSchema,
} from "./schemas";
import {
  createExamPeriod,
  createExamSlot,
  deleteExamPeriod,
  deleteExamSlot,
  generateExamSeating,
  getExamPeriod,
  getExamPeriodClashes,
  getExamPeriodSeating,
  listExamPeriods,
  moveExamSeat,
  myInvigilationDuties,
  setExamInvigilators,
  studentExamTimetable,
  updateExamPeriod,
  updateExamSlot,
} from "./service";

import type { Database } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

/**
 * Exam weeks (000265). School leadership (timetable:manage) builds exam periods, their timetable,
 * rooms, seating and invigilators, and reads clashes and the seating lists. A student's exam
 * timetable is read with student:read by whoever may read the student (the student, linked
 * parents, their teachers, leadership); a teacher reads their own invigilation duties. Both only
 * show published periods. Row checks are in the service.
 */

const TAGS = ["Exam weeks"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const listPeriodsRoute = createRoute({
  method: "get",
  path: "/api/academics/exam-periods",
  tags: TAGS,
  operationId: "listExamPeriods",
  summary: "The school's exam periods",
  description: "Newest first, optionally of one academic year.",
  security,
  request: { query: examPeriodListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Exam periods.", schema: examPeriodListSchema } },
    [400, 401, 403, 500],
  ),
});

const createPeriodRoute = createRoute({
  method: "post",
  path: "/api/academics/exam-periods",
  tags: TAGS,
  operationId: "createExamPeriod",
  summary: "Add an exam period",
  description:
    "Dates within the academic year. Starts as a draft unless `status` says published. 409 " +
    "CONFLICT_DUPLICATE_ENTRY when the year already has a period of that name.",
  security,
  request: { body: json(examPeriodBodySchema) },
  responses: standardResponses(
    { 201: { description: "The new period.", schema: examPeriodSchema } },
    [400, 401, 403, 409, 500],
  ),
});

const getPeriodRoute = createRoute({
  method: "get",
  path: "/api/academics/exam-periods/{periodId}",
  tags: TAGS,
  operationId: "getExamPeriod",
  summary: "An exam period and its timetable",
  description: "Every exam in date and time order, with its sections, rooms and invigilators.",
  security,
  request: { params: examPeriodIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The period.", schema: examPeriodSchema } },
    [401, 403, 404, 500],
  ),
});

const updatePeriodRoute = createRoute({
  method: "put",
  path: "/api/academics/exam-periods/{periodId}",
  tags: TAGS,
  operationId: "updateExamPeriod",
  summary: "Edit, publish or unpublish an exam period",
  description:
    "Publishing shows the timetable to students, parents and invigilating teachers. 409 " +
    "CONFLICT_STATE_MISMATCH when exams would fall outside the new dates or grade levels.",
  security,
  request: { params: examPeriodIdParamSchema, body: json(examPeriodBodySchema) },
  responses: standardResponses(
    { 200: { description: "The period.", schema: examPeriodSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deletePeriodRoute = createRoute({
  method: "delete",
  path: "/api/academics/exam-periods/{periodId}",
  tags: TAGS,
  operationId: "deleteExamPeriod",
  summary: "Delete an exam period",
  description: "With its timetable, seating and invigilators.",
  security,
  request: { params: examPeriodIdParamSchema },
  responses: {
    204: { description: "Deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
  },
});

const createSlotRoute = createRoute({
  method: "post",
  path: "/api/academics/exam-periods/{periodId}/slots",
  tags: TAGS,
  operationId: "createExamSlot",
  summary: "Add an exam to the timetable",
  description:
    "A subject for a grade level's sections on a date within the period, with its rooms in " +
    "filling order and optionally the gradebook assessment it is.",
  security,
  request: { params: examPeriodIdParamSchema, body: json(examSlotBodySchema) },
  responses: standardResponses(
    { 201: { description: "The exam.", schema: examSlotSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const seatingRoute = createRoute({
  method: "get",
  path: "/api/academics/exam-periods/{periodId}/seating",
  tags: TAGS,
  operationId: "getExamPeriodSeating",
  summary: "Seating lists for an exam period",
  description: "Every exam's seats by room and seat number, and its candidates without a seat.",
  security,
  request: { params: examPeriodIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Seating.", schema: examPeriodSeatingSchema } },
    [401, 403, 404, 500],
  ),
});

const clashesRoute = createRoute({
  method: "get",
  path: "/api/academics/exam-periods/{periodId}/clashes",
  tags: TAGS,
  operationId: "getExamPeriodClashes",
  summary: "Clashes in an exam period",
  description:
    "Errors (a teacher in two rooms at once, students with two exams at once, a room over " +
    "capacity, a seat used twice) then warnings (rooms without a capacity, too few seats, " +
    "unseated students, rooms nobody invigilates, exams on a holiday). Exams of other periods on " +
    "the same days are taken into account.",
  security,
  request: { params: examPeriodIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Clashes.", schema: examClashListSchema } },
    [401, 403, 404, 500],
  ),
});

const updateSlotRoute = createRoute({
  method: "put",
  path: "/api/academics/exam-slots/{slotId}",
  tags: TAGS,
  operationId: "updateExamSlot",
  summary: "Edit an exam",
  description:
    "Rooms taken off the exam lose their seats and invigilators; students who no longer sit it " +
    "lose their seat. Omit `room_ids` to keep the rooms as they are.",
  security,
  request: { params: examSlotIdParamSchema, body: json(examSlotBodySchema) },
  responses: standardResponses(
    { 200: { description: "The exam.", schema: examSlotSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const deleteSlotRoute = createRoute({
  method: "delete",
  path: "/api/academics/exam-slots/{slotId}",
  tags: TAGS,
  operationId: "deleteExamSlot",
  summary: "Delete an exam",
  description: "With its seating and invigilators.",
  security,
  request: { params: examSlotIdParamSchema },
  responses: {
    204: { description: "Deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
  },
});

const generateSeatingRoute = createRoute({
  method: "post",
  path: "/api/academics/exam-slots/{slotId}/seating",
  tags: TAGS,
  operationId: "generateExamSeating",
  summary: "Generate an exam's seating",
  description:
    "Seats the exam's candidates in its rooms by the strategy. With `keep_existing` (the " +
    "default) still-valid seats stay where they are. Seats another exam uses in a shared room at " +
    "the same time are skipped. Candidates beyond the rooms' capacity stay unseated.",
  security,
  request: { params: examSlotIdParamSchema, body: json(examSeatingBodySchema) },
  responses: standardResponses(
    { 200: { description: "The exam's seating.", schema: examSeatingResultSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const moveSeatRoute = createRoute({
  method: "put",
  path: "/api/academics/exam-slots/{slotId}/seats/{studentId}",
  tags: TAGS,
  operationId: "moveExamSeat",
  summary: "Move a student to another seat",
  description:
    "To a free seat of one of the exam's rooms, or a swap with the exam's student sitting there. " +
    "409 CONFLICT_STATE_MISMATCH when another exam in the room at the same time uses the seat.",
  security,
  request: { params: examSeatParamSchema, body: json(examSeatBodySchema) },
  responses: standardResponses(
    { 200: { description: "The exam's seating.", schema: examSlotSeatingSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const invigilatorsRoute = createRoute({
  method: "put",
  path: "/api/academics/exam-slots/{slotId}/invigilators",
  tags: TAGS,
  operationId: "setExamInvigilators",
  summary: "Set an exam's invigilators",
  description:
    "Replaces who invigilates each of the exam's rooms. Clashes are reported, not refused.",
  security,
  request: { params: examSlotIdParamSchema, body: json(examInvigilatorsBodySchema) },
  responses: standardResponses(
    { 200: { description: "The exam.", schema: examSlotSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const studentTimetableRoute = createRoute({
  method: "get",
  path: "/api/academics/students/{studentId}/exam-timetable",
  tags: TAGS,
  operationId: "getStudentExamTimetable",
  summary: "A student's exam timetable",
  description:
    "The exams of published exam periods the student sits, with their room and seat number once " +
    "seated, and the school's timezone. The student, linked parents, the student's teachers and " +
    "leadership.",
  security,
  request: { params: examStudentParamSchema },
  responses: standardResponses(
    { 200: { description: "The timetable.", schema: studentExamTimetableSchema } },
    [401, 403, 404, 500],
  ),
});

const dutiesRoute = createRoute({
  method: "get",
  path: "/api/academics/me/invigilation-duties",
  tags: TAGS,
  operationId: "getMyInvigilationDuties",
  summary: "The signed-in teacher's invigilation duties",
  description:
    "Every room the teacher invigilates in published exam periods, by date and time, with the " +
    "school's timezone. Empty for anyone who is not a teacher.",
  security,
  responses: standardResponses(
    { 200: { description: "Duties.", schema: invigilationDutyListSchema } },
    [401, 500],
  ),
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

export function examWeekRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const manage = requirePermission(PERMISSIONS.TIMETABLE_MANAGE);
  const readStudent = requirePermission(PERMISSIONS.STUDENT_READ);

  routes.use("/api/academics/exam-periods", manage, auditAction("insert", "exam_periods"));
  routes.use("/api/academics/exam-periods/:periodId", manage);
  routes.on("PUT", "/api/academics/exam-periods/:periodId", auditAction("update", "exam_periods"));
  routes.on(
    "DELETE",
    "/api/academics/exam-periods/:periodId",
    auditAction("delete", "exam_periods"),
  );
  routes.use(
    "/api/academics/exam-periods/:periodId/slots",
    manage,
    onlyMethods(["POST"], auditAction("insert", "exam_period_slots")),
  );
  routes.use("/api/academics/exam-periods/:periodId/seating", manage);
  routes.use("/api/academics/exam-periods/:periodId/clashes", manage);
  routes.use("/api/academics/exam-slots/:slotId", manage);
  routes.on("PUT", "/api/academics/exam-slots/:slotId", auditAction("update", "exam_period_slots"));
  routes.on(
    "DELETE",
    "/api/academics/exam-slots/:slotId",
    auditAction("delete", "exam_period_slots"),
  );
  routes.use(
    "/api/academics/exam-slots/:slotId/seating",
    manage,
    auditAction("update", "exam_period_seats"),
  );
  routes.use(
    "/api/academics/exam-slots/:slotId/seats/:studentId",
    manage,
    auditAction("update", "exam_period_seats"),
  );
  routes.use(
    "/api/academics/exam-slots/:slotId/invigilators",
    manage,
    auditAction("update", "exam_period_invigilators"),
  );
  routes.use("/api/academics/students/:studentId/exam-timetable", readStudent);
  // Like /api/grading/my-assignments: staff who read the academic configuration; the rows are the
  // caller's own invigilation duties. Students and parents have no duties to read.
  routes.use(
    "/api/academics/me/invigilation-duties",
    requirePermission(PERMISSIONS.ACADEMIC_CONFIG_READ),
  );

  routes.openapi(listPeriodsRoute, async (c) => {
    const { academic_year_id } = c.req.valid("query");
    const tenant = tenantFrom(c);
    const periods = await withTenantTx(database, tenant, (tx) =>
      listExamPeriods(tx, tenant.schoolId, academic_year_id),
    );
    return c.json({ periods }, 200);
  });

  routes.openapi(createPeriodRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => createExamPeriod(tx, tenant.schoolId, body)),
      201,
    );
  });

  routes.openapi(getPeriodRoute, async (c) => {
    const { periodId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => getExamPeriod(tx, tenant.schoolId, periodId)),
      200,
    );
  });

  routes.openapi(updatePeriodRoute, async (c) => {
    const { periodId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateExamPeriod(tx, tenant.schoolId, periodId, body),
      ),
      200,
    );
  });

  routes.openapi(deletePeriodRoute, async (c) => {
    const { periodId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) => deleteExamPeriod(tx, tenant.schoolId, periodId));
    return c.body(null, 204);
  });

  routes.openapi(createSlotRoute, async (c) => {
    const { periodId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        createExamSlot(tx, tenant.schoolId, periodId, body),
      ),
      201,
    );
  });

  routes.openapi(seatingRoute, async (c) => {
    const { periodId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getExamPeriodSeating(tx, tenant.schoolId, periodId),
      ),
      200,
    );
  });

  routes.openapi(clashesRoute, async (c) => {
    const { periodId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getExamPeriodClashes(tx, tenant.schoolId, periodId),
      ),
      200,
    );
  });

  routes.openapi(updateSlotRoute, async (c) => {
    const { slotId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateExamSlot(tx, tenant.schoolId, slotId, body),
      ),
      200,
    );
  });

  routes.openapi(deleteSlotRoute, async (c) => {
    const { slotId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) => deleteExamSlot(tx, tenant.schoolId, slotId));
    return c.body(null, 204);
  });

  routes.openapi(generateSeatingRoute, async (c) => {
    const { slotId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        generateExamSeating(tx, tenant.schoolId, slotId, body),
      ),
      200,
    );
  });

  routes.openapi(moveSeatRoute, async (c) => {
    const { slotId, studentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        moveExamSeat(tx, tenant.schoolId, slotId, studentId, body),
      ),
      200,
    );
  });

  routes.openapi(invigilatorsRoute, async (c) => {
    const { slotId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        setExamInvigilators(tx, tenant.schoolId, slotId, body),
      ),
      200,
    );
  });

  routes.openapi(studentTimetableRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        studentExamTimetable(tx, tenant.schoolId, studentId),
      ),
      200,
    );
  });

  routes.openapi(dutiesRoute, async (c) => {
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => myInvigilationDuties(tx, tenant.schoolId)),
      200,
    );
  });

  return routes;
}
