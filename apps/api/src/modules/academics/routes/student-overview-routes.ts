import { z, createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { requireAuth } from "../../../middleware/authContext";
import { hasPermission, requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { classIdParamSchema, studentIdParamSchema } from "../schemas";
import { getStudentOverview } from "../student-overview-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";

// ---------------------------------------------------------------------------
// Schemas. Every nested object is a named component: the mobile client's generator turns inline
// objects into classes named after the property, which can collide (see the Dart client notes).
// ---------------------------------------------------------------------------

const overviewClassSchema = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    course_name: z.string(),
    subject_id: z.string().uuid(),
    subject_name: z.string(),
    section_id: z.string().uuid().nullable(),
    section_name: z.string().nullable(),
    term_id: z.string().uuid(),
    term_name: z.string(),
  })
  .openapi("StudentOverviewClass");

const overviewStudentSchema = z
  .object({
    id: z.string().uuid(),
    first_name: z.string(),
    last_name: z.string(),
    preferred_name: z.string().nullable(),
    admission_number: z.string(),
    enrolled_at: z.string().datetime(),
  })
  .openapi("StudentOverviewStudent");

const overviewAssessmentSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    term_id: z.string().uuid().nullable(),
    max_marks: z.number(),
    assessment_date: z.string().nullable(),
    status: z.enum(["graded", "absent", "excused", "not_applicable", "pending"]),
    score: z.number().nullable(),
    descriptor_label: z.string().nullable(),
  })
  .openapi("StudentOverviewAssessment");

const overviewMarksSchema = z
  .object({
    grading_method: z.enum(["weighted", "total_points", "descriptive"]),
    result_format: z.enum(["percentage", "out_of", "gpa"]),
    result_scale_max: z.number(),
    exempt: z.boolean(),
    status: z.enum(["complete", "incomplete"]),
    percentage: z.number().nullable(),
    provisional_percentage: z.number().nullable(),
    display_value: z.number().nullable(),
    grade_label: z.string().nullable(),
    passed: z.boolean().nullable(),
    term_percentage: z.number().nullable(),
    assessments: z.array(overviewAssessmentSchema),
  })
  .openapi("StudentOverviewMarks");

const overviewAbsenceSchema = z
  .object({
    session_date: z.string(),
    status: z.enum(["absent", "late"]),
    minutes_late: z.number().int().nullable(),
  })
  .openapi("StudentOverviewAbsence");

const overviewAttendanceSchema = z
  .object({
    sessions: z.number().int(),
    present: z.number().int(),
    absent: z.number().int(),
    late: z.number().int(),
    excused: z.number().int(),
    remote: z.number().int(),
    recent: z.array(overviewAbsenceSchema),
  })
  .openapi("StudentOverviewAttendance");

const overviewHomeworkItemSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    due_at: z.string().datetime(),
    max_score: z.number(),
    status: z.enum(["submitted", "late", "graded", "returned", "missing", "upcoming"]),
    score: z.number().nullable(),
    submitted_at: z.string().datetime().nullable(),
  })
  .openapi("StudentOverviewHomeworkItem");

const overviewHomeworkSchema = z
  .object({
    total: z.number().int(),
    handed_in: z.number().int(),
    missing: z.number().int(),
    upcoming: z.number().int(),
    items: z.array(overviewHomeworkItemSchema),
  })
  .openapi("StudentOverviewHomework");

const overviewCommentsSchema = z
  .object({
    term_subject_comment: z.string().nullable(),
    annual_subject_comment: z.string().nullable(),
    term_teacher_comment: z.string().nullable(),
  })
  .openapi("StudentOverviewComments");

const overviewRecordSchema = z
  .object({
    field_id: z.string().uuid(),
    label_en: z.string(),
    label_ar: z.string(),
    value_en: z.string(),
    value_ar: z.string(),
  })
  .openapi("StudentOverviewRecord");

export const studentOverviewSchema = z
  .object({
    class: overviewClassSchema,
    student: overviewStudentSchema,
    marks: overviewMarksSchema.nullable(),
    marks_unavailable: z.enum(["no_section", "not_configured", "not_in_roster"]).nullable(),
    attendance: overviewAttendanceSchema,
    homework: overviewHomeworkSchema,
    report_comments: overviewCommentsSchema,
    records: z.array(overviewRecordSchema),
  })
  .openapi("StudentOverview");

const studentOverviewRoute = createRoute({
  method: "get",
  path: "/api/academics/classes/{classId}/students/{studentId}/overview",
  tags: ["Academics"],
  operationId: "getClassStudentOverview",
  summary: "A student as seen by a teacher of one of their classes",
  description:
    "For a teacher of the class (lead or timetabled) and a student actively enrolled in it: the " +
    "student's live marks and result in the class's subject (in the grade's result format), " +
    "attendance in this class this term, homework handed in and missing, the draft report-card " +
    "comments for the subject, and the school's record fields visible to teachers. Sensitive " +
    "record fields are never included. 403 for anyone who does not teach the class.",
  security: [{ bearerAuth: [] }],
  request: { params: classIdParamSchema.merge(studentIdParamSchema) },
  responses: standardResponses(
    {
      200: { description: "The student's overview for this class.", schema: studentOverviewSchema },
    },
    [401, 403, 404, 500],
  ),
});

export function studentOverviewRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(
    "/api/academics/classes/:classId/students/:studentId/overview",
    requirePermission(PERMISSIONS.STUDENT_READ),
  );

  routes.openapi(studentOverviewRoute, async (c) => {
    const auth = requireAuth(c);
    const { classId, studentId } = c.req.valid("param");
    const includeRecords = hasPermission(auth.roles, PERMISSIONS.STUDENT_RECORD_READ);

    const overview = await withTenantTx(
      database,
      { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
      (tx) => getStudentOverview(tx, auth.schoolId, classId, studentId, { includeRecords }),
    );

    c.header("Cache-Control", "no-store");
    return c.json(overview, 200);
  });

  return routes;
}
