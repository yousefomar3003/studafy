/**
 * Exam entries (000261) against a real migrated database with RLS armed: sessions of catalogue
 * exams, bulk entry by section / list / grade, candidate numbers, status changes, the board CSV,
 * a student's and a parent's view, results linked to their entry, and other schools.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/exam-entries/__tests__/exam-entries.integration.test.ts
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
import type { ExternalExamResultView, ExternalExamView } from "../../external-exams/service";
import type {
  ExamEntryView,
  ExamSessionSubjectCount,
  ExamSessionView,
  StudentExamEntryView,
} from "../service";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let http: TestApp;
let tenant: TenantFixture;
let otherTenant: TenantFixture;

const ids = {} as Record<string, string>;
const exams = {} as Record<string, ExternalExamView>;
const sessions = {} as Record<string, ExamSessionView>;

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
const otherAdmin = () => auth(otherTenant.users.ORG_ADMIN.id, "ORG_ADMIN", otherTenant);
const teacherAuth = () => auth(tenant.users.INSTRUCTOR.id, "INSTRUCTOR");

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  as: TestAuthContext,
  body?: unknown,
): Promise<{ status: number; body: T; text: string; headers: Headers }> {
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
  let parsed: unknown = {};
  if (text && response.headers.get("content-type")?.includes("json")) parsed = JSON.parse(text);
  return { status: response.status, body: parsed as T, text, headers: response.headers };
}

const SESSIONS = "/api/grading/external-exam-sessions";
const entriesPath = (sessionId: string) => `${SESSIONS}/${sessionId}/entries`;
const studentEntriesPath = (studentId: string) =>
  `/api/grading/students/${studentId}/external-exam-entries`;

async function sessionEntries(sessionId: string) {
  const response = await call<{
    session: ExamSessionView;
    entries: ExamEntryView[];
    subject_counts: ExamSessionSubjectCount[];
  }>("GET", entriesPath(sessionId), adminAuth());
  expect(response.status).toBe(200);
  return response.body;
}

const entryOf = (entries: readonly ExamEntryView[], studentId: string) =>
  entries.find((entry) => entry.student.id === studentId)!;

describeDb("exam entries", () => {
  test("seed: exams, subjects, a section with two students, one unplaced, a linked parent", async () => {
    for (const key of ["igcse_letter", "ielts"]) {
      const created = await call<ExternalExamView>(
        "POST",
        "/api/grading/external-exams/from-preset",
        adminAuth(),
        { preset_key: key },
      );
      expect(created.status).toBe(201);
      exams[key] = created.body;
    }
    for (const [key, code, name] of [
      ["maths", "IG-MATH", "IGCSE Mathematics"],
      ["physics", "IG-PHYS", "IGCSE Physics"],
      ["chemistry", "IG-CHEM", "IGCSE Chemistry"],
    ] as const) {
      ids[key] = (await createSubject(db.sql, tenant.schoolId, { code, name })).id;
    }
    ids.amal = tenant.students[0]!.id;
    ids.amalUser = tenant.students[0]!.userId;
    const badr = await createStudent(db.sql, tenant.schoolId, {
      firstName: "Badr",
      lastName: "Haddad",
    });
    ids.badr = badr.id;
    ids.badrUser = badr.userId;
    ids.carim = (
      await createStudent(db.sql, tenant.schoolId, { firstName: "Carim", lastName: "Zaid" })
    ).id;

    await withTenantTx(
      client!,
      { schoolId: tenant.schoolId, userId: tenant.users.ORG_ADMIN.id },
      async (tx) => {
        ids.grade10 = (
          await createGradeLevel(tx, tenant.schoolId, { name: "Grade 10", sort_order: 10 })
        ).id;
        ids.section10 = (
          await createSection(tx, tenant.schoolId, {
            academic_year_id: tenant.academicYear.id,
            grade_level_id: ids.grade10,
            name: "10A",
          })
        ).id;
      },
    );
    for (const student of [ids.amal!, ids.badr!]) {
      await db.sql`
        INSERT INTO app.student_sections (school_id, student_id, academic_year_id, section_id)
        VALUES (${tenant.schoolId}::uuid, ${student}::uuid, ${tenant.academicYear.id}::uuid,
                ${ids.section10!}::uuid)
      `;
    }

    const parent = await createUser(db.sql, tenant.schoolId, { displayName: "Amal's mother" });
    await assignRole(db.sql, tenant.schoolId, parent.id, ROLES.PARENT);
    const [family] = await db.sql<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${tenant.schoolId}::uuid, 'Entries family', ${parent.id}::uuid)
      RETURNING id
    `;
    await db.sql`
      INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${tenant.schoolId}::uuid, ${family!.id}::uuid, ${parent.id}::uuid, ${ids.amal}::uuid, 'mother')
    `;
    ids.parent = parent.id;
  });

  test("leadership adds sessions; a series is unique per exam whatever its case", async () => {
    const created = await call<ExamSessionView>("POST", SESSIONS, adminAuth(), {
      exam_id: exams.igcse_letter!.id,
      series: "May/June 2027",
      entry_deadline: "2027-02-21",
      starts_on: "2027-04-27",
      ends_on: "2027-06-10",
      results_date: "2027-08-12",
    });
    expect(created.status).toBe(201);
    expect(created.body.exam.per_subject).toBe(true);
    expect(created.body.entry_deadline).toBe("2027-02-21");
    expect(created.body.draft_count).toBe(0);
    sessions.igcse = created.body;

    const again = await call<{ code: string }>("POST", SESSIONS, adminAuth(), {
      exam_id: exams.igcse_letter!.id,
      series: "may/june 2027",
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe(ERROR_CODES.CONFLICT_DUPLICATE_ENTRY);

    const ielts = await call<ExamSessionView>("POST", SESSIONS, adminAuth(), {
      exam_id: exams.ielts!.id,
      series: "March 2027",
    });
    expect(ielts.status).toBe(201);
    sessions.ielts = ielts.body;

    // A last date needs a first one, and comes after it.
    expect(
      (
        await call("POST", SESSIONS, adminAuth(), {
          exam_id: exams.ielts!.id,
          series: "Bad",
          ends_on: "2027-01-01",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", SESSIONS, adminAuth(), {
          exam_id: exams.ielts!.id,
          series: "Bad",
          starts_on: "2027-02-01",
          ends_on: "2027-01-01",
        })
      ).status,
    ).toBe(400);

    const renamed = await call<ExamSessionView>(
      "PUT",
      `${SESSIONS}/${sessions.ielts.id}`,
      adminAuth(),
      { series: "April 2027", starts_on: "2027-04-03" },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.series).toBe("April 2027");
    sessions.ielts = renamed.body;

    const listed = await call<{ sessions: ExamSessionView[] }>("GET", SESSIONS, adminAuth());
    // Latest first: the IGCSE papers start later in April than IELTS.
    expect(listed.body.sessions.map((session) => session.id)).toEqual([
      sessions.igcse.id,
      sessions.ielts.id,
    ]);
    const onlyIelts = await call<{ sessions: ExamSessionView[] }>(
      "GET",
      `${SESSIONS}?exam_id=${exams.ielts!.id}`,
      adminAuth(),
    );
    expect(onlyIelts.body.sessions.map((session) => session.id)).toEqual([sessions.ielts.id]);
  });

  test("an archived exam takes no new session", async () => {
    const mock = await call<ExternalExamView>(
      "POST",
      "/api/grading/external-exams/from-preset",
      adminAuth(),
      { preset_key: "sat" },
    );
    await call("POST", `/api/grading/external-exams/${mock.body.id}/archive`, adminAuth());
    expect(
      (await call("POST", SESSIONS, adminAuth(), { exam_id: mock.body.id, series: "June 2027" }))
        .status,
    ).toBe(409);
  });

  test("only leadership manages sessions and entries", async () => {
    expect((await call("GET", SESSIONS, teacherAuth())).status).toBe(200);
    expect(
      (await call("POST", SESSIONS, teacherAuth(), { exam_id: exams.ielts!.id, series: "X" }))
        .status,
    ).toBe(403);
    expect((await call("GET", entriesPath(sessions.igcse!.id), teacherAuth())).status).toBe(403);
    expect(
      (
        await call("POST", entriesPath(sessions.igcse!.id), teacherAuth(), {
          student_ids: [ids.amal],
          subjects: [{ subject_id: ids.maths }],
        })
      ).status,
    ).toBe(403);
    const student = auth(ids.amalUser!, "STUDENT");
    expect((await call("GET", SESSIONS, student)).status).toBe(403);
    expect((await call("GET", `${entriesPath(sessions.igcse!.id)}/export`, student)).status).toBe(
      403,
    );
  });

  test("bulk entry by section, then by list; existing entries gain only missing subjects", async () => {
    const bySection = await call("POST", entriesPath(sessions.igcse!.id), adminAuth(), {
      section_id: ids.section10,
      subjects: [{ subject_id: ids.maths, tier: "Extended", option_code: "0580" }],
    });
    expect(bySection.status).toBe(200);
    expect(bySection.body).toEqual({ created: 2, updated: 0, unchanged: 0, skipped_withdrawn: 0 });

    const byList = await call("POST", entriesPath(sessions.igcse!.id), adminAuth(), {
      student_ids: [ids.amal, ids.carim],
      subjects: [
        { subject_id: ids.maths, tier: "Core" },
        { subject_id: ids.physics, option_code: "0625" },
      ],
    });
    expect(byList.body).toEqual({ created: 1, updated: 1, unchanged: 0, skipped_withdrawn: 0 });

    // Nothing new to add.
    const repeat = await call("POST", entriesPath(sessions.igcse!.id), adminAuth(), {
      student_ids: [ids.amal],
      subjects: [{ subject_id: ids.maths }],
    });
    expect(repeat.body).toEqual({ created: 0, updated: 0, unchanged: 1, skipped_withdrawn: 0 });

    const { session, entries, subject_counts } = await sessionEntries(sessions.igcse!.id);
    expect(session.draft_count).toBe(3);
    expect(entries.every((entry) => entry.status === "draft")).toBe(true);
    const amal = entryOf(entries, ids.amal!);
    // The first entry's tier and code are kept; the new subject is added.
    expect(amal.subjects.map((s) => [s.name, s.tier, s.option_code])).toEqual([
      ["IGCSE Mathematics", "Extended", "0580"],
      ["IGCSE Physics", null, "0625"],
    ]);
    expect(amal.student.section_name).toBe("10A");
    expect(amal.student.grade_level_name).toBe("Grade 10");
    expect(entryOf(entries, ids.carim!).student.section_name).toBeNull();
    expect(subject_counts.map((c) => [c.name, c.draft, c.entered])).toEqual([
      ["IGCSE Mathematics", 3, 0],
      ["IGCSE Physics", 2, 0],
    ]);
    ids.amalEntry = amal.id;
    ids.badrEntry = entryOf(entries, ids.badr!).id;
    ids.carimEntry = entryOf(entries, ids.carim!).id;
  });

  test("bulk entry checks the subjects and who is named", async () => {
    const path = entriesPath(sessions.igcse!.id);
    // A per-subject exam needs a subject; IELTS takes none.
    expect(
      (await call("POST", path, adminAuth(), { student_ids: [ids.amal], subjects: [] })).status,
    ).toBe(400);
    expect(
      (
        await call("POST", entriesPath(sessions.ielts!.id), adminAuth(), {
          student_ids: [ids.amal],
          subjects: [{ subject_id: ids.maths }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", path, adminAuth(), {
          student_ids: [ids.amal],
          subjects: [{ subject_id: ids.maths }, { subject_id: ids.maths }],
        })
      ).status,
    ).toBe(400);
    // Nobody named; a grade without its year.
    expect(
      (await call("POST", path, adminAuth(), { subjects: [{ subject_id: ids.maths }] })).status,
    ).toBe(400);
    expect(
      (
        await call("POST", path, adminAuth(), {
          grade_level_id: ids.grade10,
          subjects: [{ subject_id: ids.maths }],
        })
      ).status,
    ).toBe(400);
    // Another school's student and subject are not found.
    expect(
      (
        await call("POST", path, adminAuth(), {
          student_ids: [otherTenant.students[0]!.id],
          subjects: [{ subject_id: ids.maths }],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("POST", path, adminAuth(), {
          student_ids: [ids.amal],
          subjects: [{ subject_id: otherTenant.subject.id }],
        })
      ).status,
    ).toBe(404);
    // A whole grade: both placed students are already entered.
    const byGrade = await call("POST", path, adminAuth(), {
      grade_level_id: ids.grade10,
      academic_year_id: tenant.academicYear.id,
      subjects: [{ subject_id: ids.maths }],
    });
    expect(byGrade.body).toEqual({ created: 0, updated: 0, unchanged: 2, skipped_withdrawn: 0 });
  });

  test("candidate numbers are unique per session and numbered in bulk", async () => {
    const amal = await call<ExamEntryView>(
      "PUT",
      `/api/grading/external-exam-entries/${ids.amalEntry}`,
      adminAuth(),
      {
        candidate_number: "JO-0001",
        note: "Access arrangements requested",
        subjects: [
          { subject_id: ids.maths, tier: "Extended", option_code: "0580" },
          { subject_id: ids.physics, tier: "Extended", option_code: "0625" },
        ],
      },
    );
    expect(amal.status).toBe(200);
    expect(amal.body.candidate_number).toBe("JO-0001");
    expect(amal.body.subjects.map((s) => s.tier)).toEqual(["Extended", "Extended"]);

    const clash = await call<{ code: string }>(
      "PUT",
      `/api/grading/external-exam-entries/${ids.badrEntry}`,
      adminAuth(),
      { candidate_number: "jo-0001", subjects: [{ subject_id: ids.maths }] },
    );
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe(ERROR_CODES.CONFLICT_DUPLICATE_ENTRY);

    const numbered = await call(
      "POST",
      `${SESSIONS}/${sessions.igcse!.id}/candidate-numbers`,
      adminAuth(),
      { start: 1, width: 4, prefix: "JO-" },
    );
    expect(numbered.status).toBe(200);
    expect(numbered.body).toEqual({ assigned: 2 });
    const { entries } = await sessionEntries(sessions.igcse!.id);
    const numbers = entries.map((entry) => entry.candidate_number);
    expect(new Set(numbers).size).toBe(3);
    expect(numbers).toContain("JO-0001");
    expect(numbers).toContain("JO-0002");
    expect(numbers).toContain("JO-0003");
    expect(entryOf(entries, ids.amal!).candidate_number).toBe("JO-0001");

    // Nothing left to number.
    const again = await call(
      "POST",
      `${SESSIONS}/${sessions.igcse!.id}/candidate-numbers`,
      adminAuth(),
      { start: 1 },
    );
    expect(again.body).toEqual({ assigned: 0 });
  });

  test("drafts are entered, then withdrawn or reinstated; a draft is never withdrawn", async () => {
    const statusPath = `${entriesPath(sessions.igcse!.id)}/status`;
    const withdrawDraft = await call("POST", statusPath, adminAuth(), {
      entry_ids: [ids.carimEntry],
      status: "withdrawn",
    });
    expect(withdrawDraft.status).toBe(409);

    const entered = await call("POST", statusPath, adminAuth(), {
      entry_ids: [ids.amalEntry, ids.badrEntry, ids.carimEntry],
      status: "entered",
    });
    expect(entered.body).toEqual({ updated: 3 });
    // Already entered: nothing changes.
    expect(
      (
        await call("POST", statusPath, adminAuth(), {
          entry_ids: [ids.amalEntry],
          status: "entered",
        })
      ).body,
    ).toEqual({ updated: 0 });
    expect(
      (await call("POST", statusPath, adminAuth(), { entry_ids: [ids.amalEntry], status: "draft" }))
        .status,
    ).toBe(409);

    const withdrawn = await call("POST", statusPath, adminAuth(), {
      entry_ids: [ids.carimEntry],
      status: "withdrawn",
    });
    expect(withdrawn.body).toEqual({ updated: 1 });
    // An entry sent to the board is withdrawn, not deleted.
    expect(
      (await call("DELETE", `/api/grading/external-exam-entries/${ids.carimEntry}`, adminAuth()))
        .status,
    ).toBe(409);
    // A withdrawn student is skipped by bulk entry.
    const skipped = await call("POST", entriesPath(sessions.igcse!.id), adminAuth(), {
      student_ids: [ids.carim],
      subjects: [{ subject_id: ids.chemistry }],
    });
    expect(skipped.body).toEqual({ created: 0, updated: 0, unchanged: 0, skipped_withdrawn: 1 });

    const { session, entries, subject_counts } = await sessionEntries(sessions.igcse!.id);
    expect([session.draft_count, session.entered_count, session.withdrawn_count]).toEqual([
      0, 2, 1,
    ]);
    const carim = entryOf(entries, ids.carim!);
    expect(carim.entered_at).not.toBeNull();
    expect(carim.withdrawn_at).not.toBeNull();
    expect(subject_counts.find((c) => c.name === "IGCSE Physics")).toMatchObject({
      entered: 1,
      withdrawn: 1,
    });

    // An entry of another session is not found here.
    const ielts = await call("POST", entriesPath(sessions.ielts!.id), adminAuth(), {
      student_ids: [ids.badr],
      subjects: [],
    });
    expect(ielts.body).toMatchObject({ created: 1 });
    const ieltsEntries = await sessionEntries(sessions.ielts!.id);
    ids.badrIeltsEntry = ieltsEntries.entries[0]!.id;
    expect(
      (
        await call("POST", statusPath, adminAuth(), {
          entry_ids: [ids.badrIeltsEntry],
          status: "entered",
        })
      ).status,
    ).toBe(404);
  });

  test("the entry list for the board is a CSV of the entries sent, drafts on request", async () => {
    const exported = await call("GET", `${entriesPath(sessions.igcse!.id)}/export`, adminAuth());
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("text/csv");
    expect(exported.headers.get("content-disposition")).toContain(
      "igcse-may-june-2027-entries.csv",
    );
    const lines = exported.text
      .replace(/^\uFEFF/, "")
      .trim()
      .split("\r\n");
    expect(lines[0]).toBe(
      "Candidate number,Admission number,Last name,First name,Middle name,Date of birth,Exam," +
        "Series,Subject code,Subject,Tier,Option code,Status",
    );
    // Amal: two subjects; Badr: one; Carim (withdrawn): two.
    expect(lines).toHaveLength(6);
    expect(lines[1]).toContain("JO-0001");
    expect(lines[1]).toContain("IG-MATH,IGCSE Mathematics,Extended,0580,entered");
    expect(lines.filter((line) => line.endsWith(",withdrawn"))).toHaveLength(2);

    // The IELTS draft only appears with include_drafts; one row with no subject.
    const ieltsPath = `${entriesPath(sessions.ielts!.id)}/export`;
    const withoutDrafts = await call("GET", ieltsPath, adminAuth());
    expect(
      withoutDrafts.text
        .replace(/^\uFEFF/, "")
        .trim()
        .split("\r\n"),
    ).toHaveLength(1);
    const withDrafts = await call("GET", `${ieltsPath}?include_drafts=true`, adminAuth());
    const draftLines = withDrafts.text
      .replace(/^\uFEFF/, "")
      .trim()
      .split("\r\n");
    expect(draftLines).toHaveLength(2);
    expect(draftLines[1]).toContain(",IELTS,April 2027,,,,,draft");

    const [audit] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}::uuid AND action = 'export'
        AND target_table = 'external_exam_entries' AND target_id = ${sessions.igcse!.id}::uuid
    `;
    expect(audit!.count).toBe(1);
  });

  test("a student and a linked parent see the entries sent to the board, not drafts", async () => {
    const own = await call<{ entries: StudentExamEntryView[] }>(
      "GET",
      studentEntriesPath(ids.amal!),
      auth(ids.amalUser!, "STUDENT"),
    );
    expect(own.status).toBe(200);
    expect(own.body.entries).toHaveLength(1);
    const entry = own.body.entries[0]!;
    expect(entry.exam.code).toBe("IGCSE");
    expect(entry.session).toMatchObject({
      series: "May/June 2027",
      entry_deadline: "2027-02-21",
      starts_on: "2027-04-27",
      ends_on: "2027-06-10",
      results_date: "2027-08-12",
    });
    expect(entry.candidate_number).toBe("JO-0001");
    expect(entry.status).toBe("entered");
    // The subjects' names show although the student has no class in them.
    expect(entry.subjects.map((s) => [s.subject?.name, s.tier])).toEqual([
      ["IGCSE Mathematics", "Extended"],
      ["IGCSE Physics", "Extended"],
    ]);
    // The school's note is not part of the student's view.
    expect(JSON.stringify(own.body)).not.toContain("Access arrangements");

    const parent = await call<{ entries: StudentExamEntryView[] }>(
      "GET",
      studentEntriesPath(ids.amal!),
      auth(ids.parent!, "PARENT"),
    );
    expect(parent.status).toBe(200);
    expect(parent.body.entries.map((e) => e.id)).toEqual([ids.amalEntry]);

    // Badr's IELTS entry is still a draft: only his IGCSE entry shows.
    const badr = await call<{ entries: StudentExamEntryView[] }>(
      "GET",
      studentEntriesPath(ids.badr!),
      auth(ids.badrUser!, "STUDENT"),
    );
    expect(badr.body.entries.map((e) => e.exam.code)).toEqual(["IGCSE"]);
  });

  test("nobody else reads a student's entries", async () => {
    // The parent is linked to Amal only; Badr is another student.
    expect(
      (await call("GET", studentEntriesPath(ids.badr!), auth(ids.parent!, "PARENT"))).status,
    ).toBe(403);
    expect(
      (await call("GET", studentEntriesPath(ids.amal!), auth(ids.badrUser!, "STUDENT"))).status,
    ).toBe(403);
    expect((await call("GET", studentEntriesPath(ids.amal!), teacherAuth())).status).toBe(403);
    // The fixture's class teacher teaches the student.
    expect(
      (
        await call(
          "GET",
          studentEntriesPath(ids.amal!),
          auth(tenant.teachers[0]!.userId, "INSTRUCTOR"),
        )
      ).status,
    ).toBe(200);
    expect((await call("GET", studentEntriesPath(ids.amal!), otherAdmin())).status).toBe(404);
  });

  test("another school's leadership reaches none of this school's sessions or entries", async () => {
    const listed = await call<{ sessions: ExamSessionView[] }>("GET", SESSIONS, otherAdmin());
    expect(listed.body.sessions).toEqual([]);
    const sessionId = sessions.igcse!.id;
    expect((await call("GET", entriesPath(sessionId), otherAdmin())).status).toBe(404);
    expect((await call("GET", `${entriesPath(sessionId)}/export`, otherAdmin())).status).toBe(404);
    expect(
      (await call("PUT", `${SESSIONS}/${sessionId}`, otherAdmin(), { series: "Mine" })).status,
    ).toBe(404);
    expect((await call("DELETE", `${SESSIONS}/${sessionId}`, otherAdmin())).status).toBe(404);
    expect(
      (
        await call("POST", `${entriesPath(sessionId)}/status`, otherAdmin(), {
          entry_ids: [ids.amalEntry],
          status: "withdrawn",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("PUT", `/api/grading/external-exam-entries/${ids.amalEntry}`, otherAdmin(), {
          candidate_number: null,
          subjects: [],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          "DELETE",
          `/api/grading/external-exam-entries/${ids.badrIeltsEntry}`,
          otherAdmin(),
        )
      ).status,
    ).toBe(404);
    // Nor an exam of this school for a session of theirs.
    expect(
      (
        await call("POST", SESSIONS, otherAdmin(), {
          exam_id: exams.ielts!.id,
          series: "Stolen",
        })
      ).status,
    ).toBe(404);
  });

  test("RLS: rows stay in their school and follow who may read the student", async () => {
    const count = async (schoolId: string, userId: string) =>
      withTenantTx(client!, { schoolId, userId }, async (tx) => {
        const [row] = await tx<{ entries: number; subjects: number }[]>`
          SELECT (SELECT count(*)::int FROM app.external_exam_entries) AS entries,
                 (SELECT count(*)::int FROM app.external_exam_entry_subjects) AS subjects
        `;
        return row!;
      });
    expect(await count(otherTenant.schoolId, otherTenant.users.ORG_ADMIN.id)).toEqual({
      entries: 0,
      subjects: 0,
    });
    // Badr sees his own two entries (IGCSE, IELTS) and his one subject, nothing of Amal's.
    expect(await count(tenant.schoolId, ids.badrUser!)).toEqual({ entries: 2, subjects: 1 });
  });

  test("results link back to the entry they came from", async () => {
    const maths = exams.igcse_letter!;
    const scores = maths.components.map((component) => ({
      component_id: component.id,
      label_score: component.allowed_labels![0],
    }));
    const recorded = await call<ExternalExamResultView>(
      "POST",
      `/api/grading/students/${ids.amal}/external-exam-results`,
      adminAuth(),
      {
        exam_id: maths.id,
        subject_id: ids.maths,
        entry_id: ids.amalEntry,
        sat_on: "2027-05-10",
        scores,
      },
    );
    expect(recorded.status).toBe(201);
    expect(recorded.body.entry_id).toBe(ids.amalEntry);

    const bad = (body: Record<string, unknown>, studentId = ids.amal!) =>
      call("POST", `/api/grading/students/${studentId}/external-exam-results`, adminAuth(), {
        exam_id: maths.id,
        sat_on: "2027-05-10",
        scores,
        ...body,
      });
    // Another student's entry; a subject not entered; a draft entry; another exam's entry.
    expect((await bad({ subject_id: ids.maths, entry_id: ids.amalEntry }, ids.badr)).status).toBe(
      400,
    );
    expect((await bad({ subject_id: ids.chemistry, entry_id: ids.amalEntry })).status).toBe(400);
    expect(
      (await bad({ subject_id: ids.maths, entry_id: ids.badrIeltsEntry }, ids.badr)).status,
    ).toBe(400);

    // Editing the result without entry_id keeps the link; null clears it.
    const kept = await call<ExternalExamResultView>(
      "PUT",
      `/api/grading/external-exam-results/${recorded.body.id}`,
      adminAuth(),
      { subject_id: ids.maths, sat_on: "2027-05-11", scores },
    );
    expect(kept.body.entry_id).toBe(ids.amalEntry);
    const { entries } = await sessionEntries(sessions.igcse!.id);
    expect(entryOf(entries, ids.amal!).result_count).toBe(1);

    const cleared = await call<ExternalExamResultView>(
      "PUT",
      `/api/grading/external-exam-results/${recorded.body.id}`,
      adminAuth(),
      { subject_id: ids.maths, entry_id: null, sat_on: "2027-05-11", scores },
    );
    expect(cleared.body.entry_id).toBeNull();
  });

  test("drafts are deleted; a session is deleted only while nobody is entered", async () => {
    expect(
      (
        await call(
          "DELETE",
          `/api/grading/external-exam-entries/${ids.badrIeltsEntry}`,
          adminAuth(),
        )
      ).status,
    ).toBe(204);
    expect((await call("DELETE", `${SESSIONS}/${sessions.igcse!.id}`, adminAuth())).status).toBe(
      409,
    );
    expect((await call("DELETE", `${SESSIONS}/${sessions.ielts!.id}`, adminAuth())).status).toBe(
      204,
    );

    const audited = await db.sql<{ target_table: string; action: string }[]>`
      SELECT DISTINCT target_table, action::text AS action FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}::uuid
        AND target_table IN ('external_exam_sessions', 'external_exam_entries')
      ORDER BY 1, 2
    `;
    expect(audited.map((row) => `${row.target_table}:${row.action}`)).toEqual([
      "external_exam_entries:delete",
      "external_exam_entries:export",
      "external_exam_entries:insert",
      "external_exam_entries:update",
      "external_exam_sessions:delete",
      "external_exam_sessions:insert",
      "external_exam_sessions:update",
    ]);
  });
});
