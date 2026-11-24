/**
 * Arabic + English documents (000263) end to end, against a real migrated database with RLS armed:
 * Arabic names on students, subjects, grades, sections and the school; the per-school document
 * language; and what an issued certificate and transcript keep of both.
 *
 *   Grade 9 (الصف التاسع), section 9A (أ). Mathematics (الرياضيات), Science (no Arabic name).
 *   Huda Salem (هدى خالد سالم): Mathematics 88, Science 74.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/grading/__tests__/bilingual-documents.integration.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  authenticatedRequest,
  createFullTenant,
  createStudent,
  createSubject,
  createTestApp,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import {
  createGradeLevel,
  createSection,
  placeStudentInSection,
} from "../../academics/section-service";
import { getCertificate, issueCertificates, revokeCertificate } from "../certificate-service";
import { createSubjectConfig, setYearGradingStatus, upsertProgram } from "../config-service";
import { getMarkSheet, saveMarks } from "../marks-service";
import { finalizeSection, readFinalizationResults } from "../results-service";
import { issueTranscript } from "../transcript-service";

import type {
  TestApp,
  TestAuthContext,
  TestDatabase,
  TenantFixture,
} from "../../../../tests/harness";
import type { CertificateContent } from "../certificate-service";
import type { SubjectConfigInput } from "../config-service";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;
const ids = {} as Record<string, string>;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  tenant = await createFullTenant(db.sql);
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

const admin = <T>(fn: (tx: TransactionSql) => Promise<T>) =>
  withTenantTx(client!, { schoolId: tenant.schoolId, userId: tenant.users.ORG_ADMIN.id }, fn);

/** Leadership works on the web; teachers only have the app. */
const auth = (role: "ORG_ADMIN" | "INSTRUCTOR"): TestAuthContext => ({
  schoolId: tenant.schoolId,
  userId: tenant.users[role].id,
  roles: [ROLES[role]],
  channel: role === "ORG_ADMIN" ? "web" : "mobile",
});

async function call(
  method: string,
  path: string,
  as: TestAuthContext,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await authenticatedRequest(
    harness!,
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

/** One final exam out of 100: the score is the subject's percentage. */
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

async function recordFinal(subjectId: string, score: number) {
  const sheet = await admin((tx) => getMarkSheet(tx, tenant.schoolId, ids.section!, subjectId));
  const finalId = sheet.assessments.find((assessment) => assessment.name === "Final")!.id;
  await admin((tx) =>
    saveMarks(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.section!, subjectId, [
      {
        assessment_id: finalId,
        student_id: ids.huda!,
        attempt: 1 as const,
        status: "graded" as const,
        score,
        remarks: null,
      },
    ]),
  );
}

describeDb("Arabic + English documents", () => {
  test("setup: Arabic names through the API, then a finalized year", async () => {
    ids.math = (
      await createSubject(db.sql, tenant.schoolId, { code: "MATH9", name: "Mathematics" })
    ).id;
    ids.science = (
      await createSubject(db.sql, tenant.schoolId, { code: "SCI9", name: "Science" })
    ).id;
    const student = await createStudent(db.sql, tenant.schoolId, {
      firstName: "Huda",
      lastName: "Salem",
    });
    ids.huda = student.id;

    const subject = await call("PATCH", `/api/academics/subjects/${ids.math}`, auth("ORG_ADMIN"), {
      name_ar: "  الرياضيات  ",
    });
    expect(subject.status).toBe(200);
    expect(subject.body.name_ar).toBe("الرياضيات");

    const profile = await call("PATCH", `/api/students/${ids.huda}`, auth("ORG_ADMIN"), {
      first_name_ar: "هدى",
      middle_name_ar: "خالد",
      last_name_ar: "سالم",
    });
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({
      first_name: "Huda",
      first_name_ar: "هدى",
      middle_name_ar: "خالد",
      last_name_ar: "سالم",
    });

    const grade = await call("POST", "/api/academics/grade-levels", auth("ORG_ADMIN"), {
      name: "Grade 9",
      name_ar: "الصف التاسع",
      sort_order: 9,
    });
    expect(grade.status).toBe(201);
    expect(grade.body.name_ar).toBe("الصف التاسع");
    ids.grade = grade.body.id as string;

    await admin(async (tx) => {
      await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, ids.grade!, {
        grade_scale_id: null,
        mark_approval_required: false,
      });
      for (const subjectId of [ids.math!, ids.science!]) {
        await createSubjectConfig(
          tx,
          tenant.schoolId,
          tenant.users.ORG_ADMIN.id,
          { yearId: tenant.academicYear.id, gradeLevelId: ids.grade!, sectionId: null, subjectId },
          input(),
        );
      }
      const section = await createSection(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        grade_level_id: ids.grade!,
        name: "9A",
        name_ar: "أ",
      });
      expect(section).toMatchObject({ name_ar: "أ", grade_level_name_ar: "الصف التاسع" });
      ids.section = section.id;
      await placeStudentInSection(tx, tenant.schoolId, section.id, ids.huda!);
      await setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active");
    });
    await recordFinal(ids.math!, 88);
    await recordFinal(ids.science!, 74);
    const finalization = await admin((tx) =>
      finalizeSection(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.section!, null, {
        allowIncomplete: false,
      }),
    );
    ids.finalization = finalization.id;
  });

  test("results carry the Arabic names, falling back to null where there is none", async () => {
    const [result] = await admin((tx) =>
      readFinalizationResults(tx, tenant.schoolId, ids.finalization!),
    );
    expect(result).toMatchObject({ first_name_ar: "هدى", last_name_ar: "سالم" });
    const name = (subjectId: string) =>
      result!.subjects.find((subject) => subject.subject_id === subjectId)!.subject_name_ar;
    expect(name(ids.math!)).toBe("الرياضيات");
    expect(name(ids.science!)).toBeNull();
  });

  test("document language settings default to the viewer's language; leadership changes them", async () => {
    const path = "/api/grading/document-language-settings";
    const initial = await call("GET", path, auth("ORG_ADMIN"));
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({
      report_card_language: "viewer",
      certificate_language: "viewer",
      transcript_language: "viewer",
      school_name_ar: null,
    });

    expect(
      (await call("PUT", path, auth("ORG_ADMIN"), { certificate_language: "fr" })).status,
    ).toBe(400);
    expect(
      (await call("PUT", path, auth("INSTRUCTOR"), { certificate_language: "ar" })).status,
    ).toBe(403);

    const saved = await call("PUT", path, auth("ORG_ADMIN"), {
      certificate_language: "bilingual",
      transcript_language: "ar",
      school_name_ar: "مدرسة الاختبار",
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      report_card_language: "viewer",
      certificate_language: "bilingual",
      transcript_language: "ar",
      school_name_ar: "مدرسة الاختبار",
    });

    const [audit] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}::uuid AND target_table = 'document_language_settings'
    `;
    expect(audit!.count).toBeGreaterThan(0);
  });

  test("an issued certificate keeps its language and Arabic names; later changes leave it alone", async () => {
    const { issued } = await admin((tx) =>
      issueCertificates(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.finalization!, [
        ids.huda!,
      ]),
    );
    ids.certificate = issued[0]!;
    const before = (await admin((tx) => getCertificate(tx, tenant.schoolId, ids.certificate!)))
      .content;
    expect(before.language).toBe("bilingual");
    expect(before.school).toMatchObject({ name_ar: "مدرسة الاختبار" });
    expect(before.student).toMatchObject({
      first_name: "Huda",
      first_name_ar: "هدى",
      middle_name_ar: "خالد",
      last_name_ar: "سالم",
    });
    expect(before.grade_level_name_ar).toBe("الصف التاسع");
    expect(before.section_name_ar).toBe("أ");
    const subject = (content: CertificateContent, code: string) =>
      content.subjects.find((candidate) => candidate.code === code)!;
    expect(subject(before, "MATH9").name_ar).toBe("الرياضيات");
    // No Arabic name: the field is absent, not null, like every other optional document field.
    expect("name_ar" in subject(before, "SCI9")).toBe(false);

    await call("PATCH", `/api/academics/subjects/${ids.math}`, auth("ORG_ADMIN"), {
      name_ar: "رياضيات متقدمة",
    });
    await call("PUT", "/api/grading/document-language-settings", auth("ORG_ADMIN"), {
      certificate_language: "en",
    });
    const after = (await admin((tx) => getCertificate(tx, tenant.schoolId, ids.certificate!)))
      .content;
    expect(after).toEqual(before);
  });

  test("a transcript is issued in its own language; viewer stores none", async () => {
    const transcript = await admin((tx) =>
      issueTranscript(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.huda!),
    );
    expect(transcript.content.language).toBe("ar");
    expect(transcript.content.school.name_ar).toBe("مدرسة الاختبار");
    expect(transcript.content.student.first_name_ar).toBe("هدى");
    const [year] = transcript.content.years;
    expect(year).toMatchObject({ grade_level_name_ar: "الصف التاسع", section_name_ar: "أ" });
    expect(year!.subjects.find((s) => s.code === "MATH9")!.name_ar).toBe("رياضيات متقدمة");

    // Back to the reader's language: a document issued now stores no language at all.
    await call("PUT", "/api/grading/document-language-settings", auth("ORG_ADMIN"), {
      certificate_language: "viewer",
    });
    const { issued } = await admin(async (tx) => {
      await revokeCertificate(
        tx,
        tenant.schoolId,
        tenant.users.ORG_ADMIN.id,
        ids.certificate!,
        "Reissued in the reader's language",
      );
      return issueCertificates(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.finalization!, [
        ids.huda!,
      ]);
    });
    const plain = await admin((tx) => getCertificate(tx, tenant.schoolId, issued[0]!));
    expect("language" in plain.content).toBe(false);
    expect(plain.content.student.first_name_ar).toBe("هدى");
  });

  test("clearing an Arabic name, and finding a student by it", async () => {
    const found = await call(
      "GET",
      `/api/students?search=${encodeURIComponent("هدى")}&limit=10`,
      auth("ORG_ADMIN"),
    );
    expect(found.status).toBe(200);
    expect((found.body.students as { id: string }[]).map((s) => s.id)).toContain(ids.huda);

    // Global search: the Arabic name by full text (hamza-insensitive, prefix), and by typo.
    const searchIds = async (query: string) => {
      const response = await call(
        "GET",
        `/api/search?q=${encodeURIComponent(query)}&types=students`,
        auth("ORG_ADMIN"),
      );
      expect(response.status).toBe(200);
      const results = response.body.results as { students: { id: string }[] };
      return results.students.map((hit) => hit.id);
    };
    expect(await searchIds("هدى سال")).toContain(ids.huda);
    expect(await searchIds("هدي خالد سالم")).toContain(ids.huda);

    const cleared = await call("PATCH", `/api/students/${ids.huda}`, auth("ORG_ADMIN"), {
      middle_name_ar: null,
      last_name_ar: "  ",
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({
      first_name_ar: "هدى",
      middle_name_ar: null,
      last_name_ar: null,
    });

    // Omitted fields keep their value.
    const renamed = await call("PATCH", `/api/students/${ids.huda}`, auth("ORG_ADMIN"), {
      preferred_name: "Hoda",
    });
    expect(renamed.body).toMatchObject({ first_name_ar: "هدى", preferred_name: "Hoda" });
  });

  test("a course read carries its subject's Arabic name", async () => {
    await call("PATCH", `/api/academics/subjects/${tenant.subject.id}`, auth("ORG_ADMIN"), {
      name_ar: "مادة الاختبار",
    });
    const course = await call(
      "GET",
      `/api/academics/courses/${tenant.course.id}`,
      auth("ORG_ADMIN"),
    );
    expect(course.status).toBe(200);
    expect(course.body.subject_name_ar).toBe("مادة الاختبار");
  });
});
