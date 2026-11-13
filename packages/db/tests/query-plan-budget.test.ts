// ST-284: EXPLAIN budget checks for the top hot query shapes apps/api actually issues, run against
// a freshly migrated and seeded demo tenant.
//
// Each probe below is the real WHERE/ORDER BY shape of one production call site (file:line noted
// per probe, not invented) run through `EXPLAIN (FORMAT JSON)` with `enable_seqscan = off` -- the
// same technique db/seeds/index-health.ts uses for its own, smaller probe set. The demo seed is
// intentionally small, so on row count alone the planner would legitimately prefer a Seq Scan
// regardless of index health, which would prove nothing. Turning seqscan off is what makes "does an
// index exist that can serve this predicate" observable independent of table size: if a probe still
// falls back to Seq Scan with seqscan off, no index covers that predicate -- a real gap on a table
// that will not stay this small in production, not a false alarm from a tiny fixture.
//
// This is a plan-shape check, not a timing benchmark (see tests/attendance-benchmark.test.ts for
// that kind of test) -- it asserts *what access path the planner would use*, not how fast it runs.
import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { DEMO_SCHOOL_SLUG } from "../../../db/seeds/data/school";
import { seedDemoTenant } from "../../../db/seeds/seed";
import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

// Needs a seeded demo tenant (the same ~2s seed seed.test.ts budgets for) plus 20 EXPLAINs, so it
// gets its own CI step and env-var gate rather than running in the default 10-second suite -- the
// same pattern tests/attendance-benchmark.test.ts and its siblings already use.
const budgetTest = test.skipIf(!integrationEnabled || process.env.QUERY_PLAN_BUDGET !== "1");
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");

const INDEX_SCAN_NODES = new Set(["Index Scan", "Index Only Scan", "Bitmap Index Scan"]);

interface PlanNode {
  "Node Type"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function walkPlan(node: PlanNode, nodeTypes: string[], indexNames: string[]): void {
  if (node["Node Type"]) nodeTypes.push(node["Node Type"]);
  if (node["Index Name"]) indexNames.push(node["Index Name"]);
  for (const child of node.Plans ?? []) walkPlan(child, nodeTypes, indexNames);
}

interface PlanProbeResult {
  usedIndex: boolean;
  indexNames: readonly string[];
  nodeTypes: readonly string[];
}

async function explain(
  tx: TransactionSql,
  query: string,
  parameters: readonly string[],
): Promise<PlanProbeResult> {
  const rows = (await tx.unsafe(
    `EXPLAIN (FORMAT JSON) ${query}`,
    parameters as string[],
  )) as unknown as {
    "QUERY PLAN": { Plan: PlanNode }[];
  }[];
  const root = rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
  const nodeTypes: string[] = [];
  const indexNames: string[] = [];
  if (root) walkPlan(root, nodeTypes, indexNames);
  return { usedIndex: nodeTypes.some((type) => INDEX_SCAN_NODES.has(type)), indexNames, nodeTypes };
}

interface PlanProbe {
  readonly name: string;
  readonly source: string;
  readonly query: string;
  readonly bind: (fixture: Fixture) => readonly string[];
}

interface Fixture {
  schoolId: string;
  userId: string;
  classId: string;
  materialId: string;
  attendanceSessionId: string;
  attendanceStudentId: string;
  studentId: string;
  gradebookId: string;
  gradeSubmissionId: string;
  timetableVersionId: string;
  assignmentSubmissionStudentId: string;
  assignmentId: string;
  examResultStudentId: string;
  examId: string;
  invoiceStudentId: string;
  paymentStudentId: string;
  aiConversationId: string;
  aiConversationStudentId: string;
}

// Twenty real hot query shapes, one per production call site named in `source`. Each `query` is the
// literal WHERE/ORDER BY predicate that call site issues (column list trimmed to `id`/a couple of
// sort columns -- the SELECT list itself has no bearing on which index, if any, serves the scan).
const PROBES: readonly PlanProbe[] = [
  {
    name: "notifications_unread_inbox",
    source:
      "apps/api/src/modules/notifications (unread inbox) -> idx_notifications_school_user_unread",
    query: `
      SELECT id FROM app.notifications
      WHERE school_id = $1::uuid AND user_id = $2::uuid AND read_at IS NULL
      ORDER BY created_at DESC
    `,
    bind: (f) => [f.schoolId, f.userId],
  },
  {
    name: "notifications_full_history",
    source:
      "apps/api/src/modules/notifications (paginated history) -> idx_notifications_school_user_created",
    query: `
      SELECT id FROM app.notifications
      WHERE school_id = $1::uuid AND user_id = $2::uuid
      ORDER BY created_at DESC, id
    `,
    bind: (f) => [f.schoolId, f.userId],
  },
  {
    name: "enrollments_by_class",
    source:
      "apps/api/src/modules/attendance/attendance-session-service.ts (class roster) -> idx_enrollments_school_student_class",
    query: `SELECT student_id FROM app.enrollments WHERE school_id = $1::uuid AND class_id = $2::uuid`,
    bind: (f) => [f.schoolId, f.classId],
  },
  {
    name: "material_chunks_by_material",
    source:
      "apps/api/src/modules/ai/summary/materials.ts loadSummaryMaterial -> uq_material_chunks_material_chunk",
    query: `
      SELECT id FROM app.material_chunks
      WHERE school_id = $1::uuid AND material_id = $2::uuid
      ORDER BY chunk_index
    `,
    bind: (f) => [f.schoolId, f.materialId],
  },
  {
    name: "attendance_records_by_session",
    source:
      "apps/api/src/modules/attendance/attendance-session-service.ts (roster read) -> idx_attendance_records_school_session_student",
    query: `
      SELECT id FROM app.attendance_records
      WHERE school_id = $1::uuid AND attendance_session_id = $2::uuid
    `,
    bind: (f) => [f.schoolId, f.attendanceSessionId],
  },
  {
    name: "attendance_records_by_student_history",
    source: "student attendance history -> idx_attendance_records_school_student_created",
    query: `
      SELECT id FROM app.attendance_records
      WHERE school_id = $1::uuid AND student_id = $2::uuid
      ORDER BY created_at DESC, id
    `,
    bind: (f) => [f.schoolId, f.attendanceStudentId],
  },
  {
    name: "attendance_sessions_by_class_date",
    source: "attendance session open/list -> idx_attendance_sessions_school_class_date",
    query: `
      SELECT id FROM app.attendance_sessions
      WHERE school_id = $1::uuid AND class_id = $2::uuid
      ORDER BY session_date, id
    `,
    bind: (f) => [f.schoolId, f.classId],
  },
  {
    name: "grade_submissions_by_gradebook",
    source:
      "apps/api/src/modules/grades/grade-entry-service.ts getSubmissionsWithGrades/ensureDraftSubmissions -> idx_grade_submissions_school_gradebook_id",
    query: `
      SELECT id FROM app.grade_submissions
      WHERE school_id = $1::uuid AND gradebook_id = $2::uuid
      ORDER BY student_id
    `,
    bind: (f) => [f.schoolId, f.gradebookId],
  },
  {
    name: "grades_by_submission",
    source:
      "apps/api/src/modules/grades/grade-entry-service.ts getSubmissionsWithGrades -> idx_grades_school_grade_submission_id",
    query: `
      SELECT id FROM app.grades
      WHERE school_id = $1::uuid AND grade_submission_id = $2::uuid
      ORDER BY label, created_at
    `,
    bind: (f) => [f.schoolId, f.gradeSubmissionId],
  },
  {
    name: "grade_submissions_pending_queue",
    source:
      "apps/api/src/modules/grades/approval-queue-service.ts -> idx_grade_submissions_school_status_submitted_at",
    query: `
      SELECT id FROM app.grade_submissions
      WHERE school_id = $1::uuid AND status = 'submitted'::app.grade_submission_status
      ORDER BY submitted_at DESC NULLS LAST
    `,
    bind: (f) => [f.schoolId],
  },
  {
    name: "student_term_summaries_by_student",
    source:
      "apps/api/src/modules/grades/published (results-day read storm, infra/load-tests/scenarios/results-day-read-storm.js) -> idx_student_term_summaries",
    query: `
      SELECT term_gpa FROM app.student_term_summaries
      WHERE school_id = $1::uuid AND student_id = $2::uuid
    `,
    bind: (f) => [f.schoolId, f.studentId],
  },
  {
    name: "assignments_by_class_due",
    source: "assignment list for a class -> idx_assignments_school_class_due_at",
    query: `
      SELECT id FROM app.assignments
      WHERE school_id = $1::uuid AND class_id = $2::uuid
      ORDER BY due_at
    `,
    bind: (f) => [f.schoolId, f.classId],
  },
  {
    name: "assignment_submissions_by_student_assignment",
    source:
      "a student's submission for one assignment -> idx_assignment_submissions_school_student_assignment",
    query: `
      SELECT id FROM app.assignment_submissions
      WHERE school_id = $1::uuid AND student_id = $2::uuid AND assignment_id = $3::uuid
    `,
    bind: (f) => [f.schoolId, f.assignmentSubmissionStudentId, f.assignmentId],
  },
  {
    name: "exam_results_by_student_exam",
    source: "a student's result for one exam -> idx_exam_results_school_student_exam",
    query: `
      SELECT id FROM app.exam_results
      WHERE school_id = $1::uuid AND student_id = $2::uuid AND exam_id = $3::uuid
    `,
    bind: (f) => [f.schoolId, f.examResultStudentId, f.examId],
  },
  {
    name: "timetable_slots_by_version",
    source: "render one timetable version -> idx_timetable_slots_school_version_id",
    query: `
      SELECT id FROM app.timetable_slots
      WHERE school_id = $1::uuid AND timetable_version_id = $2::uuid
    `,
    bind: (f) => [f.schoolId, f.timetableVersionId],
  },
  {
    name: "timetable_slots_by_class",
    source: "a class's weekly periods -> idx_timetable_slots_school_class_id",
    query: `SELECT id FROM app.timetable_slots WHERE school_id = $1::uuid AND class_id = $2::uuid`,
    bind: (f) => [f.schoolId, f.classId],
  },
  {
    name: "invoice_cache_by_student",
    source:
      "apps/api/src/modules/finance/family/service.ts (family finance view) -> idx_invoice_cache_school_student_id",
    query: `
      SELECT id FROM app.invoice_cache
      WHERE school_id = $1::uuid AND student_id = $2::uuid
      ORDER BY issued_date DESC
    `,
    bind: (f) => [f.schoolId, f.invoiceStudentId],
  },
  {
    name: "payment_cache_by_student",
    source:
      "apps/api/src/modules/finance/family/service.ts (family finance view) -> idx_payment_cache_school_student_id",
    query: `
      SELECT id FROM app.payment_cache
      WHERE school_id = $1::uuid AND student_id = $2::uuid
      ORDER BY payment_date DESC
    `,
    bind: (f) => [f.schoolId, f.paymentStudentId],
  },
  {
    name: "ai_conversations_by_student",
    source: "a student's AI conversation list -> idx_ai_conversations_school_student_created_at",
    query: `
      SELECT id FROM app.ai_conversations
      WHERE school_id = $1::uuid AND student_id = $2::uuid
      ORDER BY created_at DESC, id DESC
    `,
    bind: (f) => [f.schoolId, f.aiConversationStudentId],
  },
  {
    name: "ai_messages_by_conversation",
    source:
      "one AI conversation's message history -> idx_ai_messages_school_conversation_created_at",
    query: `
      SELECT id FROM app.ai_messages
      WHERE school_id = $1::uuid AND conversation_id = $2::uuid
      ORDER BY created_at, id
    `,
    bind: (f) => [f.schoolId, f.aiConversationId],
  },
];

async function firstRow(
  tx: TransactionSql,
  query: string,
): Promise<Record<string, string> | undefined> {
  const rows = (await tx.unsafe(query)) as unknown as Record<string, string>[];
  return rows[0];
}

budgetTest(
  `top ${PROBES.length} hot query shapes stay index-served (no Seq Scan) on their large/growing tables`,
  async () => {
    const database = await testDatabase();
    try {
      await runMigrationCommand("migrate", {
        env: runnerEnv(database.url, repositoryMigrations),
        log: () => undefined,
      });

      const env = { DATABASE_URL: database.url, DATABASE_SSL_MODE: "disable" };
      const seeded = await seedDemoTenant({ env });
      expect(seeded.seeded).toBe(true);

      const results: ({ name: string; source: string } & PlanProbeResult)[] = [];
      const failures: string[] = [];

      await database.sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx.unsafe("SET LOCAL enable_seqscan = off");

        const schoolId = (
          await firstRow(tx, `SELECT id FROM app.schools WHERE slug = '${DEMO_SCHOOL_SLUG}'`)
        )?.id;
        if (!schoolId) throw new Error("demo school not found after seeding");
        await tx.unsafe(`SELECT set_config('app.school_id', '${schoolId}', true)`);

        const fixture: Fixture = {
          schoolId,
          userId: (await firstRow(tx, "SELECT user_id FROM app.notifications LIMIT 1"))!.user_id!,
          classId: (await firstRow(tx, "SELECT id FROM app.classes LIMIT 1"))!.id!,
          materialId: (await firstRow(tx, "SELECT material_id FROM app.material_chunks LIMIT 1"))!
            .material_id!,
          attendanceSessionId: (await firstRow(
            tx,
            "SELECT attendance_session_id FROM app.attendance_records LIMIT 1",
          ))!.attendance_session_id!,
          attendanceStudentId: (await firstRow(
            tx,
            "SELECT student_id FROM app.attendance_records LIMIT 1",
          ))!.student_id!,
          studentId: (await firstRow(tx, "SELECT id FROM app.students LIMIT 1"))!.id!,
          gradebookId: (await firstRow(tx, "SELECT id FROM app.gradebooks LIMIT 1"))!.id!,
          gradeSubmissionId: (await firstRow(tx, "SELECT id FROM app.grade_submissions LIMIT 1"))!
            .id!,
          timetableVersionId: (await firstRow(tx, "SELECT id FROM app.timetable_versions LIMIT 1"))!
            .id!,
          assignmentSubmissionStudentId: "",
          assignmentId: "",
          examResultStudentId: "",
          examId: "",
          invoiceStudentId: (await firstRow(
            tx,
            "SELECT student_id FROM app.invoice_cache LIMIT 1",
          ))!.student_id!,
          paymentStudentId: (await firstRow(
            tx,
            "SELECT student_id FROM app.payment_cache LIMIT 1",
          ))!.student_id!,
          aiConversationId: (await firstRow(
            tx,
            "SELECT conversation_id FROM app.ai_messages LIMIT 1",
          ))!.conversation_id!,
          aiConversationStudentId: (await firstRow(
            tx,
            "SELECT student_id FROM app.ai_conversations LIMIT 1",
          ))!.student_id!,
        };

        const assignmentSubmissionRow = await firstRow(
          tx,
          "SELECT student_id, assignment_id FROM app.assignment_submissions LIMIT 1",
        );
        if (assignmentSubmissionRow) {
          fixture.assignmentSubmissionStudentId = assignmentSubmissionRow.student_id!;
          fixture.assignmentId = assignmentSubmissionRow.assignment_id!;
        }

        const examResultRow = await firstRow(
          tx,
          "SELECT student_id, exam_id FROM app.exam_results LIMIT 1",
        );
        if (examResultRow) {
          fixture.examResultStudentId = examResultRow.student_id!;
          fixture.examId = examResultRow.exam_id!;
        }

        for (const [key, value] of Object.entries(fixture)) {
          if (!value) throw new Error(`fixture.${key} is missing -- demo seed did not populate it`);
        }

        for (const probe of PROBES) {
          const result = await explain(tx, probe.query, probe.bind(fixture));
          results.push({ name: probe.name, source: probe.source, ...result });
          if (!result.usedIndex) {
            failures.push(
              `${probe.name} (${probe.source}): plan fell back to ${result.nodeTypes.join(" > ")} ` +
                `with no usable index`,
            );
          }
        }
      });

      expect(results.length).toBe(PROBES.length);
      if (failures.length > 0) {
        throw new Error(
          `Seq Scan fallback on ${failures.length} probe(s):\n  ${failures.join("\n  ")}`,
        );
      }
      for (const result of results) {
        expect(result.usedIndex).toBe(true);
      }
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);
