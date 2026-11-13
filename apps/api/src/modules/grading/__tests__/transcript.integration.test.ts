/**
 * Academic transcripts (000207) against a real migrated database with RLS armed.
 *
 * Finalized results are seeded as rows (the finalization workflow itself is covered by
 * grading.integration.test.ts), so every figure below is worked out by hand:
 *
 *   2025 (Grade 9):  Mathematics 90% (weight 3, 4.0 points), Arabic 70% (weight 2, 2.0 points)
 *   2026 (Grade 10): Mathematics 80% (weight 3, 3.0 points)
 *
 *   cumulative average = (90*3 + 70*2 + 80*3) / (3+2+3) = 650 / 8 = 81.25
 *   cumulative GPA     = (4*3 + 2*2 + 3*3) / 8 = 25 / 8 = 3.125 -> 3.13
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/grading/__tests__/transcript.integration.test.ts
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
import { transcriptReadiness } from "../transcript-service";

import type {
  TestApp,
  TestAuthContext,
  TestDatabase,
  TenantFixture,
} from "../../../../tests/harness";
import type { TranscriptView } from "../transcript-service";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let http: TestApp;
let tenant: TenantFixture;

const ids = {} as Record<string, string>;

interface SeedSubject {
  subjectId: string;
  code: string;
  name: string;
  status?: "complete" | "incomplete" | "exempt";
  percentage: number | null;
  weight: number;
  gpa: number | null;
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  tenant = await createFullTenant(db.sql);
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

const admin = <T>(fn: (tx: TransactionSql) => Promise<T>) =>
  withTenantTx(client!, { schoolId: tenant.schoolId, userId: tenant.users.ORG_ADMIN.id }, fn);

const adminAuth = (): TestAuthContext => ({
  schoolId: tenant.schoolId,
  userId: tenant.users.ORG_ADMIN.id,
  roles: [ROLES.ORG_ADMIN],
});

/** Another academic year beside the fixture's active one (one active year per school). */
async function createYear(code: string, year: number, status: "closed" | "planned") {
  const [row] = await db.sql<{ id: string }[]>`
    INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
    VALUES (
      ${tenant.schoolId}::uuid, ${code}, ${`Academic Year ${year}`}, ${`${year}-01-01`}::date,
      ${`${year}-12-31`}::date, ${status}
    )
    RETURNING id
  `;
  return row!;
}

/** Insert one current annual finalization of `sectionId` with one student's stored results. */
async function seedAnnualResult(params: {
  yearId: string;
  sectionId: string;
  studentId: string;
  subjects: SeedSubject[];
  overall: { status: "complete" | "incomplete"; average: number | null };
  version?: number;
  supersedes?: string;
}): Promise<string> {
  const version = params.version ?? 1;
  const [finalization] = await db.sql<{ id: string }[]>`
    INSERT INTO app.result_finalizations (
      school_id, academic_year_id, section_id, term_id, version, finalized_by_user_id,
      supersedes_id, correction_reason
    )
    VALUES (
      ${tenant.schoolId}::uuid, ${params.yearId}::uuid, ${params.sectionId}::uuid, NULL, ${version},
      ${tenant.users.ORG_ADMIN.id}::uuid, ${params.supersedes ?? null}::uuid,
      ${version > 1 ? "Mark corrected after review" : null}
    )
    RETURNING id
  `;
  const complete = params.overall.status === "complete";
  await db.sql`
    INSERT INTO app.student_overall_results (
      school_id, finalization_id, student_id, status, average_percentage, total_obtained,
      total_max, grade_label, subjects_failed, academic_status
    )
    VALUES (
      ${tenant.schoolId}::uuid, ${finalization!.id}::uuid, ${params.studentId}::uuid,
      ${params.overall.status}, ${params.overall.average}, ${complete ? 1 : null},
      ${complete ? 1 : null}, NULL, 0, ${complete ? "promoted" : "incomplete"}
    )
  `;
  for (const subject of params.subjects) {
    const status = subject.status ?? "complete";
    const done = status === "complete";
    await db.sql`
      INSERT INTO app.student_subject_results (
        school_id, finalization_id, student_id, subject_id, status, percentage, marks_obtained,
        max_marks, grade_label, gpa_points, passed, include_in_average, include_on_certificate,
        config_snapshot, breakdown
      )
      VALUES (
        ${tenant.schoolId}::uuid, ${finalization!.id}::uuid, ${params.studentId}::uuid,
        ${subject.subjectId}::uuid, ${status}, ${done ? subject.percentage : null},
        ${done ? subject.percentage : null}, 100, NULL, ${subject.gpa}, ${done ? true : null},
        true, true,
        ${db.sql.json({
          version: 1,
          subject: { id: subject.subjectId, code: subject.code, name: subject.name },
          requirement: "mandatory",
          include_in_average: true,
          include_on_certificate: true,
          average_weight: subject.weight,
          program: { rounding: { decimals: 2, mode: "half_up" } },
        } as never)}::jsonb,
        '{}'::jsonb
      )
    `;
  }
  return finalization!.id;
}

/** The message a rejected database statement fails with ("RESOLVED" if it did not fail). */
async function errorOf(fn: () => Promise<void>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "RESOLVED";
}

async function call(
  method: string,
  path: string,
  auth: TestAuthContext,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await authenticatedRequest(
    http,
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

describeDb("academic transcripts", () => {
  test("seed two years of finalized results", async () => {
    const previous = await createYear(`AY-PREV-${tenant.schoolSlug}`, 2025, "closed");
    ids.prevYear = previous.id;
    ids.currentYear = tenant.academicYear.id;
    const [prevYearRow] = await db.sql<{ name: string }[]>`
      SELECT name FROM app.academic_years WHERE id = ${previous.id}::uuid
    `;
    ids.prevYearName = prevYearRow!.name;

    await admin(async (tx) => {
      const grade9 = await createGradeLevel(tx, tenant.schoolId, {
        name: "Grade 9",
        sort_order: 9,
      });
      const grade10 = await createGradeLevel(tx, tenant.schoolId, {
        name: "Grade 10",
        sort_order: 10,
      });
      ids.prevSection = (
        await createSection(tx, tenant.schoolId, {
          academic_year_id: previous.id,
          grade_level_id: grade9.id,
          name: "A",
        })
      ).id;
      ids.currentSection = (
        await createSection(tx, tenant.schoolId, {
          academic_year_id: tenant.academicYear.id,
          grade_level_id: grade10.id,
          name: "B",
        })
      ).id;
    });

    ids.math = (
      await createSubject(db.sql, tenant.schoolId, { code: "MATH", name: "Mathematics" })
    ).id;
    ids.arabic = (
      await createSubject(db.sql, tenant.schoolId, { code: "ARAB", name: "Arabic" })
    ).id;
    ids.art = (await createSubject(db.sql, tenant.schoolId, { code: "ART", name: "Art" })).id;
    ids.student = tenant.students[0]!.id;
    ids.studentUser = tenant.students[0]!.userId;

    await seedAnnualResult({
      yearId: ids.prevYear,
      sectionId: ids.prevSection,
      studentId: ids.student,
      subjects: [
        {
          subjectId: ids.math,
          code: "MATH",
          name: "Mathematics",
          percentage: 90,
          weight: 3,
          gpa: 4,
        },
        { subjectId: ids.arabic, code: "ARAB", name: "Arabic", percentage: 70, weight: 2, gpa: 2 },
      ],
      overall: { status: "complete", average: 82 },
    });
    ids.currentFinalization = await seedAnnualResult({
      yearId: ids.currentYear,
      sectionId: ids.currentSection,
      studentId: ids.student,
      subjects: [
        {
          subjectId: ids.math,
          code: "MATH",
          name: "Mathematics",
          percentage: 80,
          weight: 3,
          gpa: 3,
        },
      ],
      overall: { status: "complete", average: 80 },
    });
  });

  test("readiness lists the years oldest first with the weighted cumulative figures", async () => {
    const readiness = await admin((tx) => transcriptReadiness(tx, tenant.schoolId, ids.student!));
    expect(readiness.state).toBe("ready");
    expect(readiness.reasons).toEqual([]);
    expect(readiness.years.map((year) => year.grade_level_name)).toEqual(["Grade 9", "Grade 10"]);
    // (90*3 + 70*2 + 80*3) / 8 = 81.25; GPA (12 + 4 + 9) / 8 = 3.125 -> 3.13.
    expect(readiness.cumulative?.average_percentage).toBe(81.25);
    expect(readiness.cumulative?.gpa).toBe(3.13);
    expect(readiness.cumulative?.years_covered).toBe(2);
  });

  test("leadership issues one immutable transcript; a second issue is refused", async () => {
    const issued = await call(
      "POST",
      `/api/grading/students/${ids.student}/transcripts`,
      adminAuth(),
    );
    expect(issued.status).toBe(201);
    const transcript = issued.body as unknown as TranscriptView;
    expect(transcript.status).toBe("issued");
    expect(transcript.serial_number).toMatch(/^TR-[0-9A-Z]{10}$/);
    expect(transcript.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(transcript.needs_reissue).toBe(false);
    expect(transcript.content.years.map((year) => year.academic_year.id)).toEqual([
      ids.prevYear,
      ids.currentYear,
    ]);
    expect(transcript.content.years[0]!.subjects.map((s) => [s.name, s.average_weight])).toEqual([
      ["Arabic", 2],
      ["Mathematics", 3],
    ]);
    expect(transcript.content.cumulative.average_percentage).toBe(81.25);
    expect(transcript.content.cumulative.gpa).toBe(3.13);
    ids.transcript = transcript.id;
    ids.serial = transcript.serial_number;

    const again = await call(
      "POST",
      `/api/grading/students/${ids.student}/transcripts`,
      adminAuth(),
    );
    expect(again.status).toBe(409);
    expect(again.body.code).toBe(ERROR_CODES.CONFLICT_STATE_MISMATCH);

    // The database refuses edits and deletes of the stored document, whoever asks.
    expect(
      await errorOf(async () => {
        await db.sql`UPDATE app.transcripts SET content = '{}'::jsonb WHERE id = ${ids.transcript}::uuid`;
      }),
    ).toContain("cannot move from issued to issued");
    expect(
      await errorOf(async () => {
        await db.sql`
          UPDATE app.transcripts SET status = 'superseded', content = '{}'::jsonb
          WHERE id = ${ids.transcript}::uuid
        `;
      }),
    ).toContain("immutable apart from its status");
    expect(
      await errorOf(async () => {
        await db.sql`DELETE FROM app.transcripts WHERE id = ${ids.transcript}::uuid`;
      }),
    ).toContain("cannot be deleted");
  });

  test("the student and a linked parent read it; other students, teachers and outsiders cannot", async () => {
    const studentAuth: TestAuthContext = {
      schoolId: tenant.schoolId,
      userId: ids.studentUser!,
      roles: [ROLES.STUDENT],
    };
    const own = await call("GET", `/api/grading/students/${ids.student}/transcripts`, studentAuth);
    expect(own.status).toBe(200);
    expect((own.body.transcripts as TranscriptView[]).map((t) => t.id)).toEqual([ids.transcript!]);
    expect(
      (await call("GET", `/api/grading/transcripts/${ids.transcript}`, studentAuth)).status,
    ).toBe(200);
    // A student cannot issue, even for themself.
    expect(
      (await call("POST", `/api/grading/students/${ids.student}/transcripts`, studentAuth)).status,
    ).toBe(403);

    const parent = await createUser(db.sql, tenant.schoolId, { displayName: "Linked parent" });
    await assignRole(db.sql, tenant.schoolId, parent.id, ROLES.PARENT);
    const [family] = await db.sql<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${tenant.schoolId}::uuid, 'Transcript family', ${parent.id}::uuid)
      RETURNING id
    `;
    await db.sql`
      INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${tenant.schoolId}::uuid, ${family!.id}::uuid, ${parent.id}::uuid, ${ids.student}::uuid, 'mother')
    `;
    const parentAuth: TestAuthContext = {
      schoolId: tenant.schoolId,
      userId: parent.id,
      roles: [ROLES.PARENT],
    };
    expect(
      (await call("GET", `/api/grading/transcripts/${ids.transcript}`, parentAuth)).status,
    ).toBe(200);

    const other = await createStudent(db.sql, tenant.schoolId, { firstName: "Other" });
    const otherAuth: TestAuthContext = {
      schoolId: tenant.schoolId,
      userId: other.userId,
      roles: [ROLES.STUDENT],
    };
    expect(
      (await call("GET", `/api/grading/students/${ids.student}/transcripts`, otherAuth)).status,
    ).toBe(403);
    // RLS hides it: not found, not forbidden.
    expect(
      (await call("GET", `/api/grading/transcripts/${ids.transcript}`, otherAuth)).status,
    ).toBe(404);

    const teacherAuth: TestAuthContext = {
      schoolId: tenant.schoolId,
      userId: tenant.users.INSTRUCTOR.id,
      roles: [ROLES.INSTRUCTOR],
    };
    expect(
      (await call("GET", `/api/grading/students/${ids.student}/transcript-readiness`, teacherAuth))
        .status,
    ).toBe(403);
    expect(
      (await call("POST", `/api/grading/students/${ids.student}/transcripts`, teacherAuth)).status,
    ).toBe(403);
  });

  test("a correction of a covered year marks it for reissue; the reissue supersedes it", async () => {
    // Correct this year's Mathematics from 80 to 100.
    await db.sql`
      UPDATE app.result_finalizations SET status = 'superseded'
      WHERE id = ${ids.currentFinalization}::uuid
    `;
    ids.correctedFinalization = await seedAnnualResult({
      yearId: ids.currentYear!,
      sectionId: ids.currentSection!,
      studentId: ids.student!,
      subjects: [
        {
          subjectId: ids.math!,
          code: "MATH",
          name: "Mathematics",
          percentage: 100,
          weight: 3,
          gpa: 4,
        },
      ],
      overall: { status: "complete", average: 100 },
      version: 2,
      supersedes: ids.currentFinalization,
    });

    const stale = await call("GET", `/api/grading/transcripts/${ids.transcript}`, adminAuth());
    const staleView = stale.body as unknown as TranscriptView;
    expect(staleView.needs_reissue).toBe(true);
    expect(staleView.stale_reasons).toEqual(["corrected"]);
    // The stored document is untouched.
    expect(staleView.content.cumulative.average_percentage).toBe(81.25);
    const readiness = await admin((tx) => transcriptReadiness(tx, tenant.schoolId, ids.student!));
    expect(readiness.state).toBe("needs_reissue");

    const reissued = await call(
      "POST",
      `/api/grading/transcripts/${ids.transcript}/reissue`,
      adminAuth(),
      {
        reason: "Mathematics corrected after review",
      },
    );
    expect(reissued.status).toBe(201);
    const fresh = reissued.body as unknown as TranscriptView;
    // (90*3 + 70*2 + 100*3) / 8 = 710 / 8 = 88.75; GPA (12 + 4 + 12) / 8 = 3.5.
    expect(fresh.content.cumulative.average_percentage).toBe(88.75);
    expect(fresh.content.cumulative.gpa).toBe(3.5);
    expect(fresh.supersedes_id).toBe(ids.transcript!);
    expect(fresh.content.reissue).toEqual({
      supersedes_serial: ids.serial!,
      reason: "Mathematics corrected after review",
    });
    const old = await call("GET", `/api/grading/transcripts/${ids.transcript}`, adminAuth());
    expect((old.body as unknown as TranscriptView).status).toBe("superseded");
    expect((old.body as unknown as TranscriptView).needs_reissue).toBe(false);
    ids.transcript2 = fresh.id;
  });

  test("a newly finalized year is reported, and a subject without GPA points leaves the GPA out", async () => {
    const next = await createYear(`AY-NEXT-${tenant.schoolSlug}`, 2027, "planned");
    const [nextYear] = await db.sql<{ name: string }[]>`
      SELECT name FROM app.academic_years WHERE id = ${next.id}::uuid
    `;
    const section = await admin(async (tx) => {
      const grade11 = await createGradeLevel(tx, tenant.schoolId, {
        name: "Grade 11",
        sort_order: 11,
      });
      return createSection(tx, tenant.schoolId, {
        academic_year_id: next.id,
        grade_level_id: grade11.id,
        name: "C",
      });
    });
    await seedAnnualResult({
      yearId: next.id,
      sectionId: section.id,
      studentId: ids.student!,
      subjects: [
        { subjectId: ids.art!, code: "ART", name: "Art", percentage: 60, weight: 1, gpa: null },
      ],
      overall: { status: "complete", average: 60 },
    });

    const current = await call("GET", `/api/grading/transcripts/${ids.transcript2}`, adminAuth());
    expect((current.body as unknown as TranscriptView).stale_reasons).toEqual(["new_results"]);

    const readiness = await admin((tx) => transcriptReadiness(tx, tenant.schoolId, ids.student!));
    // (90*3 + 70*2 + 100*3 + 60*1) / 9 = 770 / 9 = 85.555... -> 85.56
    expect(readiness.cumulative?.average_percentage).toBe(85.56);
    expect(readiness.cumulative?.gpa).toBeNull();
    expect(readiness.cumulative?.gpa_unavailable_reason).toBe("missing_gpa_points");
    expect(readiness.cumulative?.subjects_without_gpa_points).toEqual([`Art (${nextYear!.name})`]);
  });

  test("an incomplete year or no results at all blocks issuing", async () => {
    const pending = await createStudent(db.sql, tenant.schoolId, { firstName: "Pending" });
    const none = await admin((tx) => transcriptReadiness(tx, tenant.schoolId, pending.id));
    expect(none.state).toBe("blocked");
    expect(none.reasons).toEqual([
      "There are no finalized end-of-year results for this student yet.",
    ]);

    // The student's result in the previous year's (already finalized) section is incomplete.
    const [existing] = await db.sql<{ id: string }[]>`
      SELECT id FROM app.result_finalizations
      WHERE section_id = ${ids.prevSection}::uuid AND term_id IS NULL AND status = 'finalized'
    `;
    await db.sql`
      INSERT INTO app.student_overall_results (
        school_id, finalization_id, student_id, status, subjects_failed, academic_status
      )
      VALUES (${tenant.schoolId}::uuid, ${existing!.id}::uuid, ${pending.id}::uuid, 'incomplete', 0, 'incomplete')
    `;
    await db.sql`
      INSERT INTO app.student_subject_results (
        school_id, finalization_id, student_id, subject_id, status, max_marks,
        include_in_average, include_on_certificate, config_snapshot, breakdown
      )
      VALUES (
        ${tenant.schoolId}::uuid, ${existing!.id}::uuid, ${pending.id}::uuid, ${ids.math}::uuid,
        'incomplete', 100, true, true,
        ${db.sql.json({
          subject: { id: ids.math, code: "MATH", name: "Mathematics" },
          requirement: "mandatory",
          average_weight: 3,
        } as never)}::jsonb,
        '{}'::jsonb
      )
    `;
    const blocked = await admin((tx) => transcriptReadiness(tx, tenant.schoolId, pending.id));
    expect(blocked.state).toBe("blocked");
    expect(blocked.cumulative).toBeNull();
    expect(blocked.reasons).toEqual([
      `${ids.prevYearName}: The overall result is incomplete.`,
      `${ids.prevYearName}: Mathematics is incomplete.`,
    ]);
    const refused = await call(
      "POST",
      `/api/grading/students/${pending.id}/transcripts`,
      adminAuth(),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe(ERROR_CODES.CERTIFICATE_BLOCKED);
  });

  test("revoking is final", async () => {
    const revoked = await call(
      "POST",
      `/api/grading/transcripts/${ids.transcript2}/revoke`,
      adminAuth(),
      {
        reason: "Issued to the wrong address",
      },
    );
    expect(revoked.status).toBe(200);
    expect((revoked.body as unknown as TranscriptView).status).toBe("revoked");
    expect((revoked.body as unknown as TranscriptView).revoke_reason).toBe(
      "Issued to the wrong address",
    );
    const again = await call(
      "POST",
      `/api/grading/transcripts/${ids.transcript2}/revoke`,
      adminAuth(),
      {
        reason: "Issued to the wrong address",
      },
    );
    expect(again.status).toBe(409);
    // With no current transcript, a new one can be issued.
    const readiness = await admin((tx) => transcriptReadiness(tx, tenant.schoolId, ids.student!));
    expect(readiness.state).toBe("ready");
  });
});
