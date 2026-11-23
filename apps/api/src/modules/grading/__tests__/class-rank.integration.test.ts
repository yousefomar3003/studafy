/**
 * Class rank and percentile (000257) end to end, against a real migrated database with RLS armed:
 * the grade program settings, ranks on the staff and the student/parent result endpoints, the
 * grade-level scope waiting for every section, the top students list, corrections, issued
 * documents, visibility, permissions and tenant isolation.
 *
 * Grade 9 shows its result as a percentage; one subject (Mathematics, a final exam out of 100), so
 * a student's average is their exam score:
 *
 *   9A  Amal 90, Badr 85, Carim 85, Dana 70, Eman (no mark: incomplete)
 *   9B  Fadi 88, Ghada 60
 *
 *   Section 9A:   Amal 1st, Badr and Carim 2nd, Dana 4th; Eman is not ranked (cohort of 4).
 *   Grade level:  Amal 1, Fadi 2, Badr 3, Carim 3, Dana 5, Ghada 6 (cohort of 6).
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/grading/__tests__/class-rank.integration.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createStudent,
  createSubject,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import {
  createGradeLevel,
  createSection,
  placeStudentInSection,
} from "../../academics/section-service";
import { getCertificate, issueCertificates } from "../certificate-service";
import { createSubjectConfig, setYearGradingStatus, upsertProgram } from "../config-service";
import { copyYearConfiguration } from "../copy-year-service";
import { getMarkSheet, saveMarks } from "../marks-service";
import { correctFinalization, finalizeSection } from "../results-service";
import { issueTranscript } from "../transcript-service";

import type {
  TestApp,
  TestAuthContext,
  TestDatabase,
  TenantFixture,
} from "../../../../tests/harness";
import type { ClassRank } from "../class-rank-service";
import type { ProgramInput, SubjectConfigInput } from "../config-service";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;
let other: TenantFixture;
const ids = {} as Record<string, string>;
const users = {} as Record<string, string>;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  tenant = await createFullTenant(db.sql);
  other = await createFullTenant(db.sql);
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

const adminAuth = (): TestAuthContext => ({
  schoolId: tenant.schoolId,
  userId: tenant.users.ORG_ADMIN.id,
  roles: [ROLES.ORG_ADMIN],
});
const studentAuth = (key: string): TestAuthContext => ({
  schoolId: tenant.schoolId,
  userId: users[key]!,
  roles: [ROLES.STUDENT],
});

async function call(
  method: string,
  path: string,
  auth: TestAuthContext,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await authenticatedRequest(
    harness!,
    method,
    path,
    auth,
    body === undefined
      ? undefined
      : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

/** One final exam out of 100: the score is the subject's percentage and the student's average. */
function input(): SubjectConfigInput {
  return {
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
  };
}

async function recordFinal(section: string, scores: Record<string, number>) {
  const sheet = await admin((tx) => getMarkSheet(tx, tenant.schoolId, ids[section]!, ids.math!));
  ids.finalAssessment = sheet.assessments.find((assessment) => assessment.name === "Final")!.id;
  await admin((tx) =>
    saveMarks(
      tx,
      tenant.schoolId,
      tenant.users.ORG_ADMIN.id,
      ids[section]!,
      ids.math!,
      Object.entries(scores).map(([studentKey, score]) => ({
        assessment_id: ids.finalAssessment!,
        student_id: ids[studentKey]!,
        attempt: 1 as const,
        status: "graded" as const,
        score,
        remarks: null,
      })),
    ),
  );
}

const setProgram = (values: ProgramInput) =>
  admin((tx) => upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, ids.grade!, values));

interface RankedResult {
  student_id: string;
  class_rank: ClassRank | null;
}

/** The staff view of a finalization: student key -> class rank. */
async function staffRanks(finalizationId: string): Promise<Record<string, ClassRank | null>> {
  const detail = await call("GET", `/api/grading/finalizations/${finalizationId}`, adminAuth());
  expect(detail.status).toBe(200);
  const byId = new Map(
    (detail.body.results as RankedResult[]).map((result) => [result.student_id, result.class_rank]),
  );
  return Object.fromEntries(
    ["amal", "badr", "carim", "dana", "eman", "fadi", "ghada"]
      .filter((key) => byId.has(ids[key]!))
      .map((key) => [key, byId.get(ids[key]!) ?? null]),
  );
}

/** What a student (or parent) reads on their own results endpoint for the year. */
async function ownRank(key: string, auth: TestAuthContext): Promise<ClassRank | null | undefined> {
  const own = await call("GET", `/api/grading/students/${ids[key]}/results`, auth);
  expect(own.status).toBe(200);
  const [latest] = own.body.results as { result: RankedResult }[];
  return latest?.result.class_rank;
}

const ranked = (rank: number, cohort: number, percentile: number) =>
  expect.objectContaining({ status: "ranked", rank, cohort_size: cohort, percentile });

describeDb("class rank and percentile", () => {
  test("setup: grade 9 with sections 9A and 9B", async () => {
    ids.math = (await createSubject(db.sql, tenant.schoolId, { code: "MATH", name: "Math" })).id;
    for (const name of ["Amal", "Badr", "Carim", "Dana", "Eman", "Fadi", "Ghada"]) {
      const student = await createStudent(db.sql, tenant.schoolId, {
        firstName: name,
        lastName: "Test",
      });
      ids[name.toLowerCase()] = student.id;
      users[name.toLowerCase()] = student.userId;
      await assignRole(db.sql, tenant.schoolId, student.userId, ROLES.STUDENT);
    }
    await admin(async (tx) => {
      ids.grade = (
        await createGradeLevel(tx, tenant.schoolId, { name: "Grade 9", sort_order: 9 })
      ).id;
      await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, ids.grade, {
        mark_approval_required: false,
      });
      await createSubjectConfig(
        tx,
        tenant.schoolId,
        tenant.users.ORG_ADMIN.id,
        {
          yearId: tenant.academicYear.id,
          gradeLevelId: ids.grade,
          sectionId: null,
          subjectId: ids.math!,
        },
        input(),
      );
      for (const [key, name, students] of [
        ["sectionA", "9A", ["amal", "badr", "carim", "dana", "eman"]],
        ["sectionB", "9B", ["fadi", "ghada"]],
      ] as const) {
        const section = await createSection(tx, tenant.schoolId, {
          academic_year_id: tenant.academicYear.id,
          grade_level_id: ids.grade,
          name,
        });
        ids[key] = section.id;
        for (const student of students) {
          await placeStudentInSection(tx, tenant.schoolId, section.id, ids[student]!);
        }
      }
      await setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active");
    });
    await recordFinal("sectionA", { amal: 90, badr: 85, carim: 85, dana: 70 });
    await recordFinal("sectionB", { fadi: 88, ghada: 60 });
  });

  test("the program API reads and writes the rank settings; a GPA basis needs a GPA grade", async () => {
    const path = `/api/grading/years/${tenant.academicYear.id}/programs/${ids.grade}`;
    const listed = await call(
      "GET",
      `/api/grading/years/${tenant.academicYear.id}/programs`,
      adminAuth(),
    );
    expect(listed.status).toBe(200);
    const program = (listed.body.programs as Record<string, unknown>[]).find(
      (candidate) => candidate.grade_level_id === ids.grade,
    );
    // Off by default, and the defaults are the most private choices.
    expect(program).toMatchObject({
      rank_enabled: false,
      rank_basis: "average",
      rank_scope: "section",
      rank_visibility: "staff",
    });

    for (const basis of ["gpa", "weighted_gpa"]) {
      const refused = await call("PUT", path, adminAuth(), {
        rank_enabled: true,
        rank_basis: basis,
      });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain("result shown as a GPA");
    }
    const invalid = await call("PUT", path, adminAuth(), { rank_scope: "school" });
    expect(invalid.status).toBe(400);

    const saved = await call("PUT", path, adminAuth(), {
      rank_enabled: true,
      rank_basis: "average",
      rank_scope: "section",
      rank_visibility: "staff",
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ rank_enabled: true, rank_basis: "average" });

    // A GPA grade may rank by GPA; switching its format away from GPA is then refused.
    const gpaGrade = await admin((tx) =>
      createGradeLevel(tx, tenant.schoolId, { name: "Grade 12", sort_order: 12 }),
    );
    await admin((tx) =>
      upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, gpaGrade.id, {
        result_format: "gpa",
        result_scale_max: 4,
        rank_enabled: true,
        rank_basis: "weighted_gpa",
        rank_scope: "grade_level",
        rank_visibility: "students_and_parents",
      }),
    );
    const switched = await call(
      "PUT",
      `/api/grading/years/${tenant.academicYear.id}/programs/${gpaGrade.id}`,
      adminAuth(),
      { result_format: "percentage" },
    );
    expect(switched.status).toBe(400);

    // The database refuses it too.
    let message = "RESOLVED";
    try {
      await db.sql`
        UPDATE app.grade_programs SET result_format = 'percentage', result_scale_max = NULL
        WHERE grade_level_id = ${gpaGrade.id}::uuid
      `;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("ck_grade_programs_rank_gpa_basis");

    // Copying the year carries the settings.
    const nextYear = new Date().getFullYear() + 1;
    const [year2] = await admin(
      (tx) => tx<{ id: string }[]>`
        INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
        VALUES (${tenant.schoolId}, ${`AY2-${tenant.schoolSlug}`}, 'Next year',
                ${`${nextYear}-01-01`}::date, ${`${nextYear}-12-31`}::date, 'planned')
        RETURNING id
      `,
    );
    await admin((tx) =>
      copyYearConfiguration(tx, tenant.schoolId, tenant.academicYear.id, year2!.id, {
        includeTeacherAssignments: false,
      }),
    );
    const [copied] = await db.sql<Record<string, unknown>[]>`
      SELECT rank_enabled, rank_basis, rank_scope, rank_visibility FROM app.grade_programs
      WHERE academic_year_id = ${year2!.id}::uuid AND grade_level_id = ${gpaGrade.id}::uuid
    `;
    expect(copied).toEqual({
      rank_enabled: true,
      rank_basis: "weighted_gpa",
      rank_scope: "grade_level",
      rank_visibility: "students_and_parents",
    });
  });

  test("section scope: ties share a place, the incomplete result takes none", async () => {
    const finalization = await admin((tx) =>
      finalizeSection(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.sectionA!, null, {
        allowIncomplete: true,
      }),
    );
    ids.finalA = finalization.id;
    expect(await staffRanks(ids.finalA)).toEqual({
      amal: ranked(1, 4, 75),
      badr: ranked(2, 4, 25),
      carim: ranked(2, 4, 25),
      dana: ranked(4, 4, 0),
      eman: expect.objectContaining({
        status: "not_ranked",
        rank: null,
        cohort_size: 4,
        percentile: null,
      }),
    });
    expect((await staffRanks(ids.finalA)).amal).toMatchObject({
      basis: "average",
      scope: "section",
    });
  });

  test("students and parents see the rank only when the grade shows it to them", async () => {
    // Staff only: leadership reading the student's results sees it, the student does not.
    expect(await ownRank("badr", adminAuth())).toEqual(ranked(2, 4, 25));
    expect(await ownRank("badr", studentAuth("badr"))).toBeNull();

    await setProgram({ rank_visibility: "students_and_parents" });
    expect(await ownRank("badr", studentAuth("badr"))).toEqual(ranked(2, 4, 25));

    const parent = await createUser(db.sql, tenant.schoolId, { displayName: "Badr's parent" });
    await assignRole(db.sql, tenant.schoolId, parent.id, ROLES.PARENT);
    const [family] = await db.sql<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${tenant.schoolId}::uuid, 'Rank family', ${parent.id}::uuid)
      RETURNING id
    `;
    await db.sql`
      INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${tenant.schoolId}::uuid, ${family!.id}::uuid, ${parent.id}::uuid, ${ids.badr!}::uuid, 'father')
    `;
    users.parent = parent.id;
    const parentAuth = { schoolId: tenant.schoolId, userId: parent.id, roles: [ROLES.PARENT] };
    expect(await ownRank("badr", parentAuth)).toEqual(ranked(2, 4, 25));
    // Never another family's child.
    expect(
      (await call("GET", `/api/grading/students/${ids.amal}/results`, parentAuth)).status,
    ).toBe(403);
  });

  test("a student's cohort never names a classmate", async () => {
    const rows = await as(
      users.badr!,
      (tx) => tx<{ student_id: string | null; average_percentage: string | null }[]>`
        SELECT student_id, average_percentage FROM app.class_rank_cohort(
          ${tenant.academicYear.id}::uuid, ${ids.grade!}::uuid, NULL, ${ids.sectionA!}::uuid
        )
      `,
    );
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.student_id !== null).map((row) => row.student_id)).toEqual([
      ids.badr,
    ]);
    // While the rank is for staff only, the student gets nothing at all.
    await setProgram({ rank_visibility: "staff" });
    const hidden = await as(
      users.badr!,
      (tx) => tx`
        SELECT 1 FROM app.class_rank_cohort(
          ${tenant.academicYear.id}::uuid, ${ids.grade!}::uuid, NULL, ${ids.sectionA!}::uuid
        )
      `,
    );
    expect(hidden).toHaveLength(0);
    await setProgram({ rank_visibility: "students_and_parents" });
  });

  test("grade-level scope is pending until every section is finalized", async () => {
    await setProgram({ rank_scope: "grade_level" });
    const pending = { status: "pending", scope: "grade_level", rank: null, cohort_size: null };
    expect((await staffRanks(ids.finalA!)).amal).toMatchObject(pending);
    expect(await ownRank("amal", studentAuth("amal"))).toMatchObject(pending);

    const topPath = `/api/grading/years/${tenant.academicYear.id}/programs/${ids.grade}/top-students`;
    const waiting = await call("GET", topPath, adminAuth());
    expect(waiting.status).toBe(200);
    expect(waiting.body).toMatchObject({ enabled: true, scope: "grade_level", term_id: null });
    expect(waiting.body.groups).toEqual([
      expect.objectContaining({
        section_id: null,
        status: "pending",
        pending_sections: [{ section_id: ids.sectionB, section_name: "9B" }],
        students: [],
      }),
    ]);

    const finalB = await admin((tx) =>
      finalizeSection(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.sectionB!, null, {
        allowIncomplete: false,
      }),
    );
    ids.finalB = finalB.id;
    expect(await staffRanks(ids.finalA!)).toEqual({
      amal: ranked(1, 6, 83),
      badr: ranked(3, 6, 33),
      carim: ranked(3, 6, 33),
      dana: ranked(5, 6, 16),
      eman: expect.objectContaining({ status: "not_ranked", cohort_size: 6 }),
    });
    expect(await staffRanks(ids.finalB)).toEqual({
      fadi: ranked(2, 6, 66),
      ghada: ranked(6, 6, 0),
    });
    expect(await ownRank("ghada", studentAuth("ghada"))).toEqual(ranked(6, 6, 0));

    // Top 3 places: Badr and Carim share third, so four students.
    const top = await call("GET", `${topPath}?limit=3`, adminAuth());
    expect(top.status).toBe(200);
    const [group] = top.body.groups as {
      status: string;
      cohort_size: number;
      students: { student_id: string; rank: number; section_name: string; value: number }[];
    }[];
    expect(group).toMatchObject({ status: "ranked", cohort_size: 6 });
    expect(
      group!.students.map((student) => [student.student_id, student.rank, student.section_name]),
    ).toEqual([
      [ids.amal, 1, "9A"],
      [ids.fadi, 2, "9B"],
      [ids.badr, 3, "9A"],
      [ids.carim, 3, "9A"],
    ]);
    expect(group!.students[0]!.value).toBe(90);
  });

  test("top students per section for a section rank; off when the grade does not rank", async () => {
    await setProgram({ rank_scope: "section" });
    const topPath = `/api/grading/years/${tenant.academicYear.id}/programs/${ids.grade}/top-students`;
    const top = await call("GET", `${topPath}?limit=1`, adminAuth());
    expect(top.status).toBe(200);
    const groups = top.body.groups as {
      section_name: string;
      cohort_size: number;
      students: { student_id: string }[];
    }[];
    expect(
      groups.map((group) => [
        group.section_name,
        group.cohort_size,
        group.students.map((s) => s.student_id),
      ]),
    ).toEqual([
      ["9A", 4, [ids.amal]],
      ["9B", 2, [ids.fadi]],
    ]);

    // No term of this year: 404. A term's results that are not finalized yet: pending.
    expect((await call("GET", `${topPath}?term_id=${other.term.id}`, adminAuth())).status).toBe(
      404,
    );
    const termTop = await call("GET", `${topPath}?term_id=${tenant.term.id}`, adminAuth());
    expect((termTop.body.groups as { status: string }[]).map((group) => group.status)).toEqual([
      "pending",
      "pending",
    ]);

    await setProgram({ rank_enabled: false });
    const off = await call("GET", topPath, adminAuth());
    expect(off.body).toMatchObject({ enabled: false, groups: [] });
    expect((await staffRanks(ids.finalA!)).amal).toBeNull();
    await setProgram({ rank_enabled: true, rank_scope: "grade_level" });
  });

  test("a correction re-ranks from the new version; the superseded one has no rank", async () => {
    const corrected = await admin((tx) =>
      correctFinalization(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.finalA!, {
        reason: "Dana's final exam re-marked",
        marks: [
          {
            assessment_id: ids.finalAssessment!,
            student_id: ids.dana!,
            attempt: 1,
            status: "graded",
            score: 95,
          },
        ],
        allow_incomplete: true,
      }),
    );
    expect((await staffRanks(corrected.id)).dana).toEqual(ranked(1, 6, 83));
    expect((await staffRanks(corrected.id)).amal).toEqual(ranked(2, 6, 66));
    // 9B's results did not change, its ranks did.
    expect((await staffRanks(ids.finalB!)).fadi).toEqual(ranked(3, 6, 50));
    expect((await staffRanks(ids.finalA!)).amal).toBeNull();
    ids.finalA = corrected.id;
  });

  test("documents keep the rank at issue when it is shown to students and parents", async () => {
    const issued = await admin((tx) =>
      issueCertificates(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.finalB!, [ids.fadi!]),
    );
    const certificate = await admin((tx) => getCertificate(tx, tenant.schoolId, issued.issued[0]!));
    expect(certificate.content.overall.class_rank).toEqual({
      rank: 3,
      cohort_size: 6,
      percentile: 50,
      basis: "average",
      scope: "grade_level",
    });
    const transcript = await admin((tx) =>
      issueTranscript(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.amal!),
    );
    expect(transcript.content.years[0]!.overall.class_rank).toMatchObject({
      rank: 2,
      cohort_size: 6,
    });

    // Staff-only ranks stay off the documents students and parents receive.
    await setProgram({ rank_visibility: "staff" });
    const hidden = await admin((tx) =>
      issueCertificates(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.finalB!, [ids.ghada!]),
    );
    const plain = await admin((tx) => getCertificate(tx, tenant.schoolId, hidden.issued[0]!));
    expect("class_rank" in plain.content.overall).toBe(false);

    // A certificate without a rank (as every one issued before 000257) reads back without one.
    const withoutRank = await call(
      "GET",
      `/api/grading/certificates/${hidden.issued[0]}`,
      adminAuth(),
    );
    expect(withoutRank.status).toBe(200);
    expect(
      (withoutRank.body.content as { overall: Record<string, unknown> }).overall.class_rank,
    ).toBeUndefined();
    // Issued content never changes: turning the rank back on does not add it to Ghada's.
    await setProgram({ rank_visibility: "students_and_parents" });
    const still = await admin((tx) => getCertificate(tx, tenant.schoolId, hidden.issued[0]!));
    expect("class_rank" in still.content.overall).toBe(false);
  });

  test("top students is for school leadership, within its own school", async () => {
    const topPath = `/api/grading/years/${tenant.academicYear.id}/programs/${ids.grade}/top-students`;
    expect((await call("GET", topPath, studentAuth("amal"))).status).toBe(403);
    expect(
      (
        await call("GET", topPath, {
          schoolId: tenant.schoolId,
          userId: users.parent!,
          roles: [ROLES.PARENT],
        })
      ).status,
    ).toBe(403);

    // Another school's leadership cannot reach this grade, by its ids or through its own year.
    const otherAdmin: TestAuthContext = {
      schoolId: other.schoolId,
      userId: other.users.ORG_ADMIN.id,
      roles: [ROLES.ORG_ADMIN],
    };
    expect((await call("GET", topPath, otherAdmin)).status).toBe(404);
    expect(
      (
        await call(
          "GET",
          `/api/grading/years/${other.academicYear.id}/programs/${ids.grade}/top-students`,
          otherAdmin,
        )
      ).status,
    ).toBe(404);
    expect((await call("GET", `/api/grading/finalizations/${ids.finalA}`, otherAdmin)).status).toBe(
      404,
    );

    // The cohort function is tenant-bound: another school's session reads nothing of this one.
    const leaked = await withTenantTx(
      client!,
      { schoolId: other.schoolId, userId: other.users.ORG_ADMIN.id },
      (tx) => tx`
        SELECT 1 FROM app.class_rank_cohort(
          ${tenant.academicYear.id}::uuid, ${ids.grade!}::uuid, NULL, NULL
        )
      `,
    );
    expect(leaked).toHaveLength(0);
  });
});
