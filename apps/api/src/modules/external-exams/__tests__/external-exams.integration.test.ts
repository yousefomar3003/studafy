/**
 * External exams and test scores (000255) against a real migrated database with RLS armed.
 *
 *   SAT   720 + 760          = 1480
 *   IELTS (6.5 + 6.5 + 5 + 7) / 4 = 6.25 -> 6.5 (nearest half band, halves up)
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/external-exams/__tests__/external-exams.integration.test.ts
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
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import { createGradeLevel, createSection } from "../../academics/section-service";

import type {
  TestApp,
  TestAuthContext,
  TestDatabase,
  TenantFixture,
} from "../../../../tests/harness";
import type { TranscriptView } from "../../grading/transcript-service";
import type { ExternalExamResultView, ExternalExamView } from "../service";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let http: TestApp;
let tenant: TenantFixture;
let otherTenant: TenantFixture;

const ids = {} as Record<string, string>;
const exams = {} as Record<string, ExternalExamView>;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  tenant = await createFullTenant(db.sql);
  otherTenant = await createFullTenant(db.sql);
  client = postgres(db.url, { max: 1, prepare: false });
  const created = createTestApp({ database: db.sql });
  await created.ready;
  http = created;
}, 120_000);

afterAll(async () => {
  http?.keyStore.destroy();
  if (client) await client.end({ timeout: 1 });
  if (db?.cleanup) await db.cleanup();
});

const auth = (userId: string, role: keyof typeof ROLES, fixture = tenant): TestAuthContext => ({
  schoolId: fixture.schoolId,
  userId,
  roles: [ROLES[role]],
});
const adminAuth = () => auth(tenant.users.ORG_ADMIN.id, "ORG_ADMIN");
const studentAuth = () => auth(ids.studentUser!, "STUDENT");

async function call(
  method: string,
  path: string,
  as: TestAuthContext,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await authenticatedRequest(
    http,
    method,
    path,
    as,
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

const resultsPath = (studentId: string) =>
  `/api/grading/students/${studentId}/external-exam-results`;

function scoresFor(exam: ExternalExamView, values: (number | string)[]) {
  return exam.components.map((component, index) => {
    const value = values[index]!;
    return typeof value === "number"
      ? { component_id: component.id, numeric_score: value }
      : { component_id: component.id, label_score: value };
  });
}

describeDb("external exams and test scores", () => {
  test("seed: a student, a linked parent, and a subject the student has no class in", async () => {
    ids.student = tenant.students[0]!.id;
    ids.studentUser = tenant.students[0]!.userId;
    ids.mathematics = (
      await createSubject(db.sql, tenant.schoolId, { code: "IG-MATH", name: "IGCSE Mathematics" })
    ).id;
    const parent = await createUser(db.sql, tenant.schoolId, { displayName: "Linked parent" });
    await assignRole(db.sql, tenant.schoolId, parent.id, ROLES.PARENT);
    const [family] = await db.sql<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${tenant.schoolId}::uuid, 'Exam family', ${parent.id}::uuid)
      RETURNING id
    `;
    await db.sql`
      INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${tenant.schoolId}::uuid, ${family!.id}::uuid, ${parent.id}::uuid, ${ids.student}::uuid, 'father')
    `;
    ids.parent = parent.id;
  });

  test("leadership adds exams from presets; codes are unique per school", async () => {
    const presets = await call("GET", "/api/grading/external-exam-presets", adminAuth());
    expect(presets.status).toBe(200);
    expect((presets.body.presets as { key: string }[]).map((p) => p.key)).toContain("ielts");

    for (const key of ["sat", "ielts", "igcse_letter"]) {
      const created = await call("POST", "/api/grading/external-exams/from-preset", adminAuth(), {
        preset_key: key,
      });
      expect(created.status).toBe(201);
      exams[key] = created.body as unknown as ExternalExamView;
    }
    expect(exams.sat!.total_mode).toBe("sum");
    expect(exams.sat!.components.map((c) => c.name)).toEqual(["Reading and Writing", "Math"]);
    expect(exams.igcse_letter!.per_subject).toBe(true);

    const duplicate = await call("POST", "/api/grading/external-exams/from-preset", adminAuth(), {
      preset_key: "sat",
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe(ERROR_CODES.CONFLICT_DUPLICATE_ENTRY);
    // Case does not make a code new.
    const lower = await call("POST", "/api/grading/external-exams/from-preset", adminAuth(), {
      preset_key: "sat",
      code: "sat",
    });
    expect(lower.status).toBe(409);

    // Another school can use the same code.
    const elsewhere = await call(
      "POST",
      "/api/grading/external-exams/from-preset",
      auth(otherTenant.users.ORG_ADMIN.id, "ORG_ADMIN", otherTenant),
      { preset_key: "sat" },
    );
    expect(elsewhere.status).toBe(201);
    ids.otherSchoolExam = (elsewhere.body as unknown as ExternalExamView).id;
  });

  test("a custom exam is validated by the grading engine", async () => {
    const bad = await call("POST", "/api/grading/external-exams", adminAuth(), {
      code: "MOCK",
      name: "Mock",
      total_mode: "sum",
      per_subject: false,
      show_on_transcript: false,
      components: [{ name: "Paper 1", score_type: "label", allowed_labels: ["Pass", "Fail"] }],
    });
    expect(bad.status).toBe(400);
    expect(String(bad.body.detail ?? bad.body.message)).toContain("number");

    const good = await call("POST", "/api/grading/external-exams", adminAuth(), {
      code: "MOCK",
      name: "School mock exam",
      total_mode: "average",
      total_rounding_step: null,
      total_min: 0,
      total_max: 100,
      per_subject: false,
      show_on_transcript: false,
      components: [
        { name: "Paper 1", score_type: "numeric", min_score: 0, max_score: 100, step: 1 },
        { name: "Paper 2", score_type: "numeric", min_score: 0, max_score: 100, step: 1 },
      ],
    });
    expect(good.status).toBe(201);
    exams.mock = good.body as unknown as ExternalExamView;
  });

  test("only leadership manages the catalogue", async () => {
    const teacher = auth(tenant.users.INSTRUCTOR.id, "INSTRUCTOR");
    expect((await call("GET", "/api/grading/external-exams", teacher)).status).toBe(200);
    expect(
      (
        await call("POST", "/api/grading/external-exams/from-preset", teacher, {
          preset_key: "act",
        })
      ).status,
    ).toBe(403);
    expect((await call("GET", "/api/grading/external-exams", studentAuth())).status).toBe(403);
    expect(
      (await call("POST", `/api/grading/external-exams/${exams.sat!.id}/archive`, studentAuth()))
        .status,
    ).toBe(403);
    // Another school's exam is not there for this school's leadership.
    expect(
      (
        await call(
          "POST",
          `/api/grading/external-exams/${ids.otherSchoolExam}/archive`,
          adminAuth(),
        )
      ).status,
    ).toBe(404);
  });

  test("recording a result validates every score and works out the total", async () => {
    const sat = exams.sat!;
    const offStep = await call("POST", resultsPath(ids.student!), adminAuth(), {
      exam_id: sat.id,
      sat_on: "2026-10-04",
      scores: scoresFor(sat, [725, 760]),
    });
    expect(offStep.status).toBe(400);
    const outOfRange = await call("POST", resultsPath(ids.student!), adminAuth(), {
      exam_id: sat.id,
      sat_on: "2026-10-04",
      scores: scoresFor(sat, [900, 760]),
    });
    expect(outOfRange.status).toBe(400);
    const withSubject = await call("POST", resultsPath(ids.student!), adminAuth(), {
      exam_id: sat.id,
      subject_id: ids.mathematics,
      sat_on: "2026-10-04",
      scores: scoresFor(sat, [720, 760]),
    });
    expect(withSubject.status).toBe(400);

    const recorded = await call("POST", resultsPath(ids.student!), adminAuth(), {
      exam_id: sat.id,
      sat_on: "2026-10-04",
      note: "First sitting",
      // A client-sent total would be ignored; there is no field for one.
      scores: scoresFor(sat, [720, 760]),
    });
    expect(recorded.status).toBe(201);
    const result = recorded.body as unknown as ExternalExamResultView;
    expect(result.total_score).toBe(1480);
    expect(result.sat_on).toBe("2026-10-04");
    expect(result.scores.map((s) => [s.component_name, s.numeric_score])).toEqual([
      ["Reading and Writing", 720],
      ["Math", 760],
    ]);
    ids.satResult = result.id;

    // Part of an exam: recorded, but no total.
    const partial = await call("POST", resultsPath(ids.student!), adminAuth(), {
      exam_id: sat.id,
      sat_on: "2026-06-01",
      scores: [{ component_id: sat.components[1]!.id, numeric_score: 700 }],
    });
    expect(partial.status).toBe(201);
    expect((partial.body as unknown as ExternalExamResultView).total_score).toBeNull();
    ids.partialResult = (partial.body as unknown as ExternalExamResultView).id;

    const ielts = exams.ielts!;
    const band = await call("POST", resultsPath(ids.student!), adminAuth(), {
      exam_id: ielts.id,
      sat_on: "2026-09-12",
      scores: scoresFor(ielts, [6.5, 6.5, 5, 7]),
    });
    expect(band.status).toBe(201);
    expect((band.body as unknown as ExternalExamResultView).total_score).toBe(6.5);

    // A score of one exam's component on another exam is refused by the API and the database.
    const crossed = await call("POST", resultsPath(ids.student!), adminAuth(), {
      exam_id: ielts.id,
      sat_on: "2026-09-12",
      scores: [{ component_id: sat.components[0]!.id, numeric_score: 7 }],
    });
    expect(crossed.status).toBe(400);
    let error = "RESOLVED";
    try {
      await db.sql`
        INSERT INTO app.student_external_exam_scores (
          school_id, result_id, student_id, exam_id, component_id, numeric_score
        )
        VALUES (
          ${tenant.schoolId}::uuid, ${ids.satResult}::uuid, ${ids.student}::uuid,
          ${sat.id}::uuid, ${ielts.components[0]!.id}::uuid, 7
        )
      `;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    expect(error).toContain("fk_student_external_exam_scores_component");
  });

  test("a per-subject exam needs a subject and one of its grades", async () => {
    const igcse = exams.igcse_letter!;
    const noSubject = await call("POST", resultsPath(ids.student!), adminAuth(), {
      exam_id: igcse.id,
      sat_on: "2026-06-15",
      scores: scoresFor(igcse, ["A*"]),
    });
    expect(noSubject.status).toBe(400);
    const unknownGrade = await call("POST", resultsPath(ids.student!), adminAuth(), {
      exam_id: igcse.id,
      subject_id: ids.mathematics,
      sat_on: "2026-06-15",
      scores: scoresFor(igcse, ["Z"]),
    });
    expect(unknownGrade.status).toBe(400);
    const numberForGrade = await call("POST", resultsPath(ids.student!), adminAuth(), {
      exam_id: igcse.id,
      subject_id: ids.mathematics,
      sat_on: "2026-06-15",
      scores: [{ component_id: igcse.components[0]!.id, numeric_score: 9 }],
    });
    expect(numberForGrade.status).toBe(400);
    const recorded = await call("POST", resultsPath(ids.student!), adminAuth(), {
      exam_id: igcse.id,
      subject_id: ids.mathematics,
      sat_on: "2026-06-15",
      scores: scoresFor(igcse, ["A*"]),
    });
    expect(recorded.status).toBe(201);
    const result = recorded.body as unknown as ExternalExamResultView;
    expect(result.subject?.name).toBe("IGCSE Mathematics");
    expect(result.total_score).toBeNull();
    expect(result.scores[0]!.label_score).toBe("A*");
    ids.igcseResult = result.id;
  });

  test("editing a result replaces its scores and works the total out again", async () => {
    const sat = exams.sat!;
    const edited = await call(
      "PUT",
      `/api/grading/external-exam-results/${ids.satResult}`,
      adminAuth(),
      {
        sat_on: "2026-10-04",
        note: null,
        scores: scoresFor(sat, [740, 790]),
      },
    );
    expect(edited.status).toBe(200);
    const result = edited.body as unknown as ExternalExamResultView;
    expect(result.total_score).toBe(1530);
    expect(result.note).toBeNull();

    const [audit] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}::uuid
        AND target_table = 'student_external_exam_results' AND target_id = ${ids.satResult}::uuid
    `;
    expect(audit!.count).toBe(2);
  });

  test("once results exist, how an exam is scored and totalled is locked", async () => {
    const sat = exams.sat!;
    const body = {
      code: sat.code,
      name: "SAT (digital)",
      total_mode: sat.total_mode,
      total_rounding_step: sat.total_rounding_step,
      total_min: sat.total_min,
      total_max: sat.total_max,
      per_subject: sat.per_subject,
      show_on_transcript: true,
      components: sat.components.map((c) => ({
        id: c.id,
        name: c.name,
        score_type: c.score_type,
        min_score: c.min_score,
        max_score: c.max_score,
        step: c.step,
      })),
    };
    const renamed = await call("PUT", `/api/grading/external-exams/${sat.id}`, adminAuth(), body);
    expect(renamed.status).toBe(200);
    expect((renamed.body as unknown as ExternalExamView).name).toBe("SAT (digital)");
    expect(
      (renamed.body as unknown as ExternalExamView).components.every((c) => c.has_scores),
    ).toBe(true);

    const averaged = await call("PUT", `/api/grading/external-exams/${sat.id}`, adminAuth(), {
      ...body,
      total_mode: "average",
    });
    expect(averaged.status).toBe(409);
    const rescaled = await call("PUT", `/api/grading/external-exams/${sat.id}`, adminAuth(), {
      ...body,
      components: body.components.map((c, i) => (i === 0 ? { ...c, max_score: 900 } : c)),
    });
    expect(rescaled.status).toBe(409);
    const removed = await call("PUT", `/api/grading/external-exams/${sat.id}`, adminAuth(), {
      ...body,
      components: body.components.slice(1),
    });
    expect(removed.status).toBe(409);

    // An exam without results is still freely editable: swap the mock's two papers' names.
    const mock = exams.mock!;
    const swapped = await call("PUT", `/api/grading/external-exams/${mock.id}`, adminAuth(), {
      code: mock.code,
      name: mock.name,
      total_mode: "sum",
      total_min: 0,
      total_max: 200,
      per_subject: false,
      show_on_transcript: false,
      components: [
        { ...mock.components[1]!, name: "Paper 1" },
        { ...mock.components[0]!, name: "Paper 2" },
      ].map(({ id, name, score_type, min_score, max_score, step }) => ({
        id,
        name,
        score_type,
        min_score,
        max_score,
        step,
      })),
    });
    expect(swapped.status).toBe(200);
    const after = swapped.body as unknown as ExternalExamView;
    expect(after.total_mode).toBe("sum");
    expect(after.components.map((c) => [c.id, c.name])).toEqual([
      [mock.components[1]!.id, "Paper 1"],
      [mock.components[0]!.id, "Paper 2"],
    ]);
  });

  test("an archived exam takes no new results until it is restored", async () => {
    const mock = exams.mock!;
    const archived = await call(
      "POST",
      `/api/grading/external-exams/${mock.id}/archive`,
      adminAuth(),
    );
    expect(archived.status).toBe(200);
    expect((archived.body as unknown as ExternalExamView).archived_at).not.toBeNull();
    const listed = await call("GET", "/api/grading/external-exams", adminAuth());
    expect((listed.body.exams as ExternalExamView[]).map((e) => e.id)).not.toContain(mock.id);
    const all = await call("GET", "/api/grading/external-exams?include_archived=true", adminAuth());
    expect((all.body.exams as ExternalExamView[]).map((e) => e.id)).toContain(mock.id);

    const refused = await call("POST", resultsPath(ids.student!), adminAuth(), {
      exam_id: mock.id,
      sat_on: "2026-05-01",
      scores: [{ component_id: mock.components[0]!.id, numeric_score: 50 }],
    });
    expect(refused.status).toBe(409);
    expect(
      (await call("POST", `/api/grading/external-exams/${mock.id}/restore`, adminAuth())).status,
    ).toBe(200);
  });

  test("the student, a linked parent and the student's teacher read the results; nobody else", async () => {
    const own = await call("GET", resultsPath(ids.student!), studentAuth());
    expect(own.status).toBe(200);
    const results = own.body.results as ExternalExamResultView[];
    expect(results.map((r) => r.id)).toContain(ids.satResult!);
    // Newest sitting first.
    expect(results.map((r) => r.sat_on)).toEqual(
      [...results.map((r) => r.sat_on)].sort().reverse(),
    );
    // The subject's name shows although the student has no class in it.
    expect(results.find((r) => r.id === ids.igcseResult)?.subject?.name).toBe("IGCSE Mathematics");

    const parent = await call("GET", resultsPath(ids.student!), auth(ids.parent!, "PARENT"));
    expect(parent.status).toBe(200);
    expect((parent.body.results as ExternalExamResultView[]).length).toBe(results.length);

    // The fixture's class teacher teaches the student.
    const teacher = await call(
      "GET",
      resultsPath(ids.student!),
      auth(tenant.teachers[0]!.userId, "INSTRUCTOR"),
    );
    expect(teacher.status).toBe(200);

    const unrelatedTeacher = auth(tenant.users.INSTRUCTOR.id, "INSTRUCTOR");
    expect((await call("GET", resultsPath(ids.student!), unrelatedTeacher)).status).toBe(403);
    const other = await createStudent(db.sql, tenant.schoolId, { firstName: "Other" });
    expect(
      (await call("GET", resultsPath(ids.student!), auth(other.userId, "STUDENT"))).status,
    ).toBe(403);
    // Another school's leadership: the student is not in their school.
    const otherAdmin = auth(otherTenant.users.ORG_ADMIN.id, "ORG_ADMIN", otherTenant);
    expect((await call("GET", resultsPath(ids.student!), otherAdmin)).status).toBe(404);

    // RLS hides the rows themselves from anyone who may not read the student.
    const hidden = await withTenantTx(
      client!,
      { schoolId: tenant.schoolId, userId: other.userId },
      (tx) => tx<{ count: number }[]>`
        SELECT (SELECT count(*) FROM app.student_external_exam_results)
             + (SELECT count(*) FROM app.student_external_exam_scores) AS count
      `,
    );
    expect(Number(hidden[0]!.count)).toBe(0);
  });

  test("students, parents, teachers and other schools cannot record, edit or delete", async () => {
    const sat = exams.sat!;
    const body = { exam_id: sat.id, sat_on: "2026-10-04", scores: scoresFor(sat, [500, 500]) };
    for (const as of [
      studentAuth(),
      auth(ids.parent!, "PARENT"),
      auth(tenant.teachers[0]!.userId, "INSTRUCTOR"),
    ]) {
      expect((await call("POST", resultsPath(ids.student!), as, body)).status).toBe(403);
      expect(
        (await call("DELETE", `/api/grading/external-exam-results/${ids.satResult}`, as)).status,
      ).toBe(403);
    }
    const otherAdmin = auth(otherTenant.users.ORG_ADMIN.id, "ORG_ADMIN", otherTenant);
    expect((await call("POST", resultsPath(ids.student!), otherAdmin, body)).status).toBe(404);
    expect(
      (
        await call("PUT", `/api/grading/external-exam-results/${ids.satResult}`, otherAdmin, {
          sat_on: "2026-10-04",
          scores: scoresFor(sat, [500, 500]),
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("DELETE", `/api/grading/external-exam-results/${ids.satResult}`, otherAdmin))
        .status,
    ).toBe(404);
  });

  test("transcripts carry the exams shown on them, as they stood at issue", async () => {
    // One finalized year so a transcript can be issued.
    const sectionId = await withTenantTx(
      client!,
      { schoolId: tenant.schoolId, userId: tenant.users.ORG_ADMIN.id },
      async (tx) => {
        const grade = await createGradeLevel(tx, tenant.schoolId, {
          name: "Grade 11",
          sort_order: 11,
        });
        return (
          await createSection(tx, tenant.schoolId, {
            academic_year_id: tenant.academicYear.id,
            grade_level_id: grade.id,
            name: "A",
          })
        ).id;
      },
    );
    const [finalization] = await db.sql<{ id: string }[]>`
      INSERT INTO app.result_finalizations (
        school_id, academic_year_id, section_id, term_id, version, finalized_by_user_id
      )
      VALUES (
        ${tenant.schoolId}::uuid, ${tenant.academicYear.id}::uuid, ${sectionId}::uuid, NULL, 1,
        ${tenant.users.ORG_ADMIN.id}::uuid
      )
      RETURNING id
    `;
    await db.sql`
      INSERT INTO app.student_overall_results (
        school_id, finalization_id, student_id, status, average_percentage, total_obtained,
        total_max, grade_label, subjects_failed, academic_status
      )
      VALUES (
        ${tenant.schoolId}::uuid, ${finalization!.id}::uuid, ${ids.student}::uuid, 'complete', 80,
        80, 100, NULL, 0, 'promoted'
      )
    `;
    await db.sql`
      INSERT INTO app.student_subject_results (
        school_id, finalization_id, student_id, subject_id, status, percentage, marks_obtained,
        max_marks, grade_label, gpa_points, passed, include_in_average, include_on_certificate,
        config_snapshot, breakdown
      )
      VALUES (
        ${tenant.schoolId}::uuid, ${finalization!.id}::uuid, ${ids.student}::uuid,
        ${ids.mathematics}::uuid, 'complete', 80, 80, 100, NULL, NULL, true, true, true,
        ${db.sql.json({
          version: 1,
          subject: { id: ids.mathematics, code: "IG-MATH", name: "IGCSE Mathematics" },
          requirement: "mandatory",
          include_in_average: true,
          include_on_certificate: true,
          average_weight: 1,
          program: { rounding: { decimals: 2, mode: "half_up" } },
        } as never)}::jsonb,
        '{}'::jsonb
      )
    `;

    // The mock exam is not shown on transcripts; give it a result to prove it stays off.
    const mock = exams.mock!;
    expect(
      (
        await call("POST", resultsPath(ids.student!), adminAuth(), {
          exam_id: mock.id,
          sat_on: "2026-05-01",
          scores: [{ component_id: mock.components[0]!.id, numeric_score: 50 }],
        })
      ).status,
    ).toBe(201);

    const issued = await call(
      "POST",
      `/api/grading/students/${ids.student}/transcripts`,
      adminAuth(),
    );
    expect(issued.status).toBe(201);
    const transcript = issued.body as unknown as TranscriptView;
    const section = transcript.content.external_exams ?? [];
    expect(section.map((exam) => exam.code)).toEqual(["IELTS", "IGCSE", "SAT"]);
    const sat = section.find((exam) => exam.code === "SAT")!;
    expect(sat.name).toBe("SAT (digital)");
    expect(sat.total_max).toBe(1600);
    // Oldest sitting first: the partial June sitting, then October's.
    expect(sat.results.map((r) => [r.sat_on, r.total_score])).toEqual([
      ["2026-06-01", null],
      ["2026-10-04", 1530],
    ]);
    const igcse = section.find((exam) => exam.code === "IGCSE")!;
    expect(igcse.results[0]!.subject).toEqual({ code: "IG-MATH", name: "IGCSE Mathematics" });
    expect(igcse.results[0]!.scores[0]!.label_score).toBe("A*");

    // Deleting a result later does not reach the issued document.
    expect(
      (await call("DELETE", `/api/grading/external-exam-results/${ids.partialResult}`, adminAuth()))
        .status,
    ).toBe(204);
    const reread = await call("GET", `/api/grading/transcripts/${transcript.id}`, studentAuth());
    expect(reread.status).toBe(200);
    const stored = (reread.body as unknown as TranscriptView).content.external_exams!;
    expect(stored.find((exam) => exam.code === "SAT")!.results).toHaveLength(2);
    const listed = await call("GET", resultsPath(ids.student!), adminAuth());
    expect((listed.body.results as ExternalExamResultView[]).map((r) => r.id)).not.toContain(
      ids.partialResult!,
    );
  });
});
