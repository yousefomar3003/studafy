/**
 * Predicted grades (000254) end to end, against a real migrated database with RLS armed: the
 * program switch, label validation against the subject's scale, who may write, who may read
 * (including the student and parent visibility switch), the audit trail and tenant isolation.
 * Later tests build on earlier ones.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/grading/__tests__/predicted-grades.integration.test.ts
 */

import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createStudent,
  createSubject,
  createTeacher,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import {
  createGradeLevel,
  createSection,
  placeStudentInSection,
} from "../../academics/section-service";
import {
  createScale,
  createSubjectConfig,
  createTeacherAssignment,
  setYearGradingStatus,
  upsertProgram,
} from "../config-service";
import {
  getSectionPredictedGrades,
  getStudentPredictedGrades,
  savePredictedGrades,
} from "../predicted-grades-service";

import type {
  TestApp,
  TestAuthContext,
  TestDatabase,
  TenantFixture,
} from "../../../../tests/harness";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;
let otherTenant: TenantFixture;
const ids = {} as Record<string, string>;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  tenant = await createFullTenant(db.sql);
  otherTenant = await createFullTenant(db.sql);
  client = postgres(db.url, { max: 1, prepare: false });
  const created = createTestApp({ database: db.sql });
  await created.ready;
  harness = created;
}, 120_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  if (client) await client.end({ timeout: 1 });
  if (db?.cleanup) await db.cleanup();
});

const as = <T>(userId: string, fn: (tx: TransactionSql) => Promise<T>) =>
  withTenantTx(client!, { schoolId: tenant.schoolId, userId }, fn);
const admin = <T>(fn: (tx: TransactionSql) => Promise<T>) => as(tenant.users.ORG_ADMIN.id, fn);
const teacher = <T>(fn: (tx: TransactionSql) => Promise<T>) => as(tenant.teachers[0]!.userId, fn);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CodedHttpException) return error.code;
    return String((error as { code?: string }).code ?? error);
  }
  return "RESOLVED";
}

async function call(method: string, path: string, auth: TestAuthContext, body?: unknown) {
  const response = await authenticatedRequest(
    harness!,
    method,
    path,
    auth,
    body === undefined
      ? undefined
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

const sectionPath = () =>
  `/api/grading/sections/${ids.section}/subjects/${ids.math}/predicted-grades`;

describeDb("predicted grades", () => {
  test("setup: a grade with an A*-U scale, one subject, a section of two students", async () => {
    ids.math = (await createSubject(db.sql, tenant.schoolId, { code: "MTH", name: "Math" })).id;
    ids.s1 = tenant.students[0]!.id;
    ids.s1User = tenant.students[0]!.userId;
    const second = await createStudent(db.sql, tenant.schoolId, {
      firstName: "Badr",
      lastName: "Test",
    });
    ids.s2 = second.id;
    ids.stranger = (
      await createStudent(db.sql, tenant.schoolId, { firstName: "Other", lastName: "Section" })
    ).id;
    await assignRole(db.sql, tenant.schoolId, tenant.students[0]!.userId, ROLES.STUDENT);
    await assignRole(db.sql, tenant.schoolId, tenant.teachers[0]!.userId, ROLES.INSTRUCTOR);
    const outsider = await createTeacher(db.sql, tenant.schoolId);
    await assignRole(db.sql, tenant.schoolId, outsider.userId, ROLES.INSTRUCTOR);
    ids.outsiderUser = outsider.userId;

    await admin(async (tx) => {
      const scale = await createScale(tx, tenant.schoolId, tenant.academicYear.id, {
        name: "A-Level",
        bands: [
          { label: "A*", min_percentage: 90, gpa_points: null },
          { label: "A", min_percentage: 80, gpa_points: null },
          { label: "B", min_percentage: 70, gpa_points: null },
          { label: "C", min_percentage: 60, gpa_points: null },
          { label: "U", min_percentage: 0, gpa_points: null },
        ],
      });
      const grade = await createGradeLevel(tx, tenant.schoolId, {
        name: "Year 13",
        sort_order: 13,
      });
      ids.grade = grade.id;
      const program = await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, grade.id, {
        grade_scale_id: scale.id,
        mark_approval_required: false,
      });
      // Off by default: nothing changes for a school that never turns it on.
      expect(program.predicted_grades_enabled).toBe(false);
      expect(program.predicted_grades_visibility).toBe("staff");
      await createSubjectConfig(
        tx,
        tenant.schoolId,
        tenant.users.ORG_ADMIN.id,
        {
          yearId: tenant.academicYear.id,
          gradeLevelId: grade.id,
          sectionId: null,
          subjectId: ids.math!,
        },
        {
          requirement: "mandatory",
          include_in_average: true,
          include_on_certificate: true,
          average_weight: 1,
          grading_method: "weighted",
          max_marks: 100,
          pass_percentage: 50,
          final_exam_pass_percentage: null,
          grade_scale_id: null,
          rounding_decimals: 2,
          rounding_mode: "half_up",
          missing_mark_policy: "incomplete",
          absent_policy: "incomplete",
          retake_policy: "none",
          retake_cap_percentage: null,
          teachers_can_add_assessments: false,
          teacher_assessments_require_approval: true,
          instructions: null,
          term_weights: [],
          categories: [
            {
              ref: "final",
              name: "Final",
              kind: "final_exam",
              scope: "annual",
              weight: 100,
              aggregation: "weighted_average",
              drop_lowest: 0,
              sort_order: 0,
            },
          ],
          assessments: [
            {
              category_ref: "final",
              term_id: null,
              name: "Final",
              max_marks: 100,
              weight: 1,
              is_mandatory: true,
              assessment_date: null,
              due_date: null,
              sort_order: 0,
            },
          ],
        },
      );
      const section = await createSection(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        grade_level_id: grade.id,
        name: "13A",
      });
      ids.section = section.id;
      await placeStudentInSection(tx, tenant.schoolId, section.id, ids.s1!);
      await placeStudentInSection(tx, tenant.schoolId, section.id, ids.s2!);
      await createTeacherAssignment(tx, tenant.schoolId, {
        section_id: section.id,
        subject_id: ids.math!,
        teacher_id: tenant.teachers[0]!.id,
      });
      await setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active");
    });
  });

  test("a disabled program shows the roster but refuses predictions", async () => {
    const view = await teacher((tx) =>
      getSectionPredictedGrades(tx, tenant.schoolId, ids.section!, ids.math!, null),
    );
    expect(view.enabled).toBe(false);
    expect(view.editable).toBe(false);
    expect(view.labels).toEqual(["A*", "A", "B", "C", "U"]);
    expect(view.students.map((s) => s.student_id).sort()).toEqual([ids.s1!, ids.s2!].sort());
    expect(
      await codeOf(
        teacher((tx) =>
          savePredictedGrades(
            tx,
            tenant.schoolId,
            tenant.teachers[0]!.userId,
            ids.section!,
            ids.math!,
            null,
            [{ student_id: ids.s1!, grade_label: "A" }],
          ),
        ),
      ),
    ).toBe(ERROR_CODES.PREDICTED_GRADES_DISABLED);

    await admin((tx) =>
      upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, ids.grade!, {
        predicted_grades_enabled: true,
      }),
    );
  });

  test("the subject teacher saves term and annual predictions from the scale", async () => {
    const save = (termId: string | null, grades: Parameters<typeof savePredictedGrades>[6]) =>
      teacher((tx) =>
        savePredictedGrades(
          tx,
          tenant.schoolId,
          tenant.teachers[0]!.userId,
          ids.section!,
          ids.math!,
          termId,
          grades,
        ),
      );
    expect(
      await save(null, [
        { student_id: ids.s1!, grade_label: "A*", note: "Strong mocks" },
        { student_id: ids.s2!, grade_label: " B " },
      ]),
    ).toEqual({ saved: 2, cleared: 0 });
    expect(await save(tenant.term.id, [{ student_id: ids.s1!, grade_label: "A" }])).toEqual({
      saved: 1,
      cleared: 0,
    });

    const annual = await teacher((tx) =>
      getSectionPredictedGrades(tx, tenant.schoolId, ids.section!, ids.math!, null),
    );
    const byId = new Map(annual.students.map((s) => [s.student_id, s]));
    expect(byId.get(ids.s1!)).toMatchObject({ grade_label: "A*", note: "Strong mocks" });
    expect(byId.get(ids.s2!)).toMatchObject({ grade_label: "B", note: null });
    const term = await teacher((tx) =>
      getSectionPredictedGrades(tx, tenant.schoolId, ids.section!, ids.math!, tenant.term.id),
    );
    expect(term.students.find((s) => s.student_id === ids.s1)?.grade_label).toBe("A");

    // Omitting the note keeps it; a new label replaces the old one in place.
    await save(null, [{ student_id: ids.s1!, grade_label: "A" }]);
    const [row] = await db.sql<{ grade_label: string; note: string | null; count: string }[]>`
      SELECT grade_label, note, (SELECT count(*) FROM app.student_predicted_grades
        WHERE student_id = ${ids.s1!}::uuid AND term_id IS NULL) AS count
      FROM app.student_predicted_grades
      WHERE student_id = ${ids.s1!}::uuid AND term_id IS NULL
    `;
    expect(row).toEqual({ grade_label: "A", note: "Strong mocks", count: "1" });

    // A blank label removes the prediction.
    expect(await save(null, [{ student_id: ids.s2!, grade_label: "" }])).toEqual({
      saved: 0,
      cleared: 1,
    });
  });

  test("labels outside the scale, students outside the subject and duplicates are refused", async () => {
    const save = (grades: Parameters<typeof savePredictedGrades>[6]) =>
      teacher((tx) =>
        savePredictedGrades(
          tx,
          tenant.schoolId,
          tenant.teachers[0]!.userId,
          ids.section!,
          ids.math!,
          null,
          grades,
        ),
      );
    expect(await codeOf(save([{ student_id: ids.s1!, grade_label: "A**" }]))).toBe(
      ERROR_CODES.VALIDATION_FAILED,
    );
    expect(await codeOf(save([{ student_id: ids.stranger!, grade_label: "A" }]))).toBe(
      ERROR_CODES.VALIDATION_FAILED,
    );
    expect(
      await codeOf(
        save([
          { student_id: ids.s1!, grade_label: "A" },
          { student_id: ids.s1!, grade_label: "B" },
        ]),
      ),
    ).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  test("a teacher who does not teach the subject in the section can neither read nor write", async () => {
    const outsider = <T>(fn: (tx: TransactionSql) => Promise<T>) => as(ids.outsiderUser!, fn);
    expect(
      await codeOf(
        outsider((tx) =>
          getSectionPredictedGrades(tx, tenant.schoolId, ids.section!, ids.math!, null),
        ),
      ),
    ).toBe(ERROR_CODES.AUTHZ_FORBIDDEN);
    expect(
      await codeOf(
        outsider((tx) =>
          savePredictedGrades(
            tx,
            tenant.schoolId,
            ids.outsiderUser!,
            ids.section!,
            ids.math!,
            null,
            [{ student_id: ids.s1!, grade_label: "U" }],
          ),
        ),
      ),
    ).toBe(ERROR_CODES.AUTHZ_FORBIDDEN);
    // RLS: the outsider's own query sees no predictions at all.
    const rows = await outsider((tx) => tx`SELECT id FROM app.student_predicted_grades`);
    expect(rows.length).toBe(0);
  });

  test("every save is audited with the old and new values", async () => {
    const rows = await db.sql<{ old_values: unknown; new_values: unknown }[]>`
      SELECT old_values, new_values FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}::uuid AND target_table = 'student_predicted_grades'
      ORDER BY created_at
    `;
    expect(rows.length).toBe(4);
    expect(rows[2]).toMatchObject({
      old_values: { grades: { [ids.s1!]: { grade_label: "A*", note: "Strong mocks" } } },
      new_values: { grades: { [ids.s1!]: { grade_label: "A", note: "Strong mocks" } } },
    });
    expect(rows[3]).toMatchObject({
      old_values: { grades: { [ids.s2!]: { grade_label: "B" } } },
      new_values: { grades: { [ids.s2!]: null } },
    });
  });

  test("students and parents see predictions only when the program shows them, without notes", async () => {
    const parent = await createUser(db.sql, tenant.schoolId, { displayName: "Linked parent" });
    await assignRole(db.sql, tenant.schoolId, parent.id, ROLES.PARENT);
    const [family] = await db.sql<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${tenant.schoolId}::uuid, 'Predicted family', ${parent.id}::uuid)
      RETURNING id
    `;
    await db.sql`
      INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${tenant.schoolId}::uuid, ${family!.id}::uuid, ${parent.id}::uuid, ${ids.s1}::uuid, 'mother')
    `;
    ids.parentUser = parent.id;

    for (const userId of [ids.s1User!, parent.id]) {
      const hidden = await as(userId, (tx) =>
        getStudentPredictedGrades(tx, tenant.schoolId, ids.s1!),
      );
      expect(hidden.years).toEqual([]);
      const raw = await as(userId, (tx) => tx`SELECT id FROM app.student_predicted_grades`);
      expect(raw.length).toBe(0);
    }

    await admin((tx) =>
      upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, ids.grade!, {
        predicted_grades_visibility: "students_and_parents",
      }),
    );
    for (const userId of [ids.s1User!, parent.id]) {
      const shown = await as(userId, (tx) =>
        getStudentPredictedGrades(tx, tenant.schoolId, ids.s1!),
      );
      expect(shown.years).toHaveLength(1);
      const year = shown.years[0]!;
      expect(year.can_edit).toBe(false);
      expect(year.subjects).toEqual([]);
      // The subject's name comes back with the prediction (app.can_read_subject's 000254 arm).
      expect(new Set(year.grades.map((g) => g.subject_name))).toEqual(new Set(["Math"]));
      expect(
        year.grades
          .map((g) => [g.term_id, g.grade_label, g.note])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ).toEqual(
        [
          [null, "A", null],
          [tenant.term.id, "A", null],
        ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );
    }
    // Their own only: the student cannot read a classmate's predictions.
    expect(
      await codeOf(
        as(ids.s1User!, (tx) => getStudentPredictedGrades(tx, tenant.schoolId, ids.s2!)),
      ),
    ).toBe(ERROR_CODES.ACCESS_DENIED);
  });

  test("leadership reads every year with the subjects and labels it may edit", async () => {
    const view = await admin((tx) => getStudentPredictedGrades(tx, tenant.schoolId, ids.s1!));
    expect(view.years).toHaveLength(1);
    const year = view.years[0]!;
    expect(year).toMatchObject({
      section_id: ids.section,
      enabled: true,
      visibility: "students_and_parents",
      can_edit: true,
    });
    expect(year.subjects).toEqual([
      { subject_id: ids.math!, subject_name: "Math", labels: ["A*", "A", "B", "C", "U"] },
    ]);
    expect(year.terms.map((t) => t.term_id)).toContain(tenant.term.id);
    expect(year.grades.find((g) => g.term_id === null)?.note).toBe("Strong mocks");
  });

  test("HTTP: role gates and tenant isolation", async () => {
    const adminAuth: TestAuthContext = {
      schoolId: tenant.schoolId,
      userId: tenant.users.ORG_ADMIN.id,
      roles: [ROLES.ORG_ADMIN],
    };
    const teacherAuth: TestAuthContext = {
      schoolId: tenant.schoolId,
      userId: tenant.teachers[0]!.userId,
      roles: [ROLES.INSTRUCTOR],
    };
    const studentAuth: TestAuthContext = {
      schoolId: tenant.schoolId,
      userId: ids.s1User!,
      roles: [ROLES.STUDENT],
    };
    const parentAuth: TestAuthContext = {
      schoolId: tenant.schoolId,
      userId: ids.parentUser!,
      roles: [ROLES.PARENT],
    };
    const foreignAdmin: TestAuthContext = {
      schoolId: otherTenant.schoolId,
      userId: otherTenant.users.ORG_ADMIN.id,
      roles: [ROLES.ORG_ADMIN],
    };

    const read = await call("GET", `${sectionPath()}?term_id=${tenant.term.id}`, teacherAuth);
    expect(read.status).toBe(200);
    expect(read.body.term_id).toBe(tenant.term.id);

    const put = await call("PUT", sectionPath(), teacherAuth, {
      term_id: null,
      grades: [{ student_id: ids.s2, grade_label: "C", note: null }],
    });
    expect(put.status).toBe(200);
    const students = put.body.students as { student_id: string; grade_label: string | null }[];
    expect(students.find((s) => s.student_id === ids.s2)?.grade_label).toBe("C");

    const badLabel = await call("PUT", sectionPath(), adminAuth, {
      term_id: null,
      grades: [{ student_id: ids.s2, grade_label: "Z" }],
    });
    expect(badLabel.status).toBe(400);

    // Students and parents read their own through the student route, never the section's.
    expect((await call("GET", sectionPath(), studentAuth)).status).toBe(403);
    expect(
      (
        await call("PUT", sectionPath(), studentAuth, {
          term_id: null,
          grades: [{ student_id: ids.s1, grade_label: "A*" }],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("PUT", sectionPath(), parentAuth, {
          term_id: null,
          grades: [{ student_id: ids.s1, grade_label: "A*" }],
        })
      ).status,
    ).toBe(403);
    const own = await call("GET", `/api/grading/students/${ids.s1}/predicted-grades`, parentAuth);
    expect(own.status).toBe(200);
    expect((own.body.years as unknown[]).length).toBe(1);
    expect(
      (await call("GET", `/api/grading/students/${ids.s2}/predicted-grades`, parentAuth)).status,
    ).toBe(403);

    // Another school's administrator reaches nothing of this school.
    expect((await call("GET", sectionPath(), foreignAdmin)).status).toBe(404);
    expect(
      (
        await call("PUT", sectionPath(), foreignAdmin, {
          term_id: null,
          grades: [{ student_id: ids.s1, grade_label: "U" }],
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("GET", `/api/grading/students/${ids.s1}/predicted-grades`, foreignAdmin)).status,
    ).toBe(404);
    const [unchanged] = await db.sql<{ grade_label: string }[]>`
      SELECT grade_label FROM app.student_predicted_grades
      WHERE student_id = ${ids.s1!}::uuid AND term_id IS NULL
    `;
    expect(unchanged?.grade_label).toBe("A");
  });

  test("a finalized year's predictions are read-only", async () => {
    // Straight to finalized: finalizing for real needs every result in place, beside the point here.
    await db.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
      await tx`
        UPDATE app.academic_years SET grading_config_status = 'finalized'
        WHERE id = ${tenant.academicYear.id}::uuid
      `;
    });
    const view = await teacher((tx) =>
      getSectionPredictedGrades(tx, tenant.schoolId, ids.section!, ids.math!, null),
    );
    expect(view.editable).toBe(false);
    expect(
      await codeOf(
        teacher((tx) =>
          savePredictedGrades(
            tx,
            tenant.schoolId,
            tenant.teachers[0]!.userId,
            ids.section!,
            ids.math!,
            null,
            [{ student_id: ids.s1!, grade_label: "U" }],
          ),
        ),
      ),
    ).toBe(ERROR_CODES.ACADEMIC_CONFIG_LOCKED);
  });
});
