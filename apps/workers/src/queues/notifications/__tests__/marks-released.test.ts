/**
 * MARKS_RELEASED notices (000230): marks.released outbox events become inbox rows for the section's
 * students with a released mark and their parents, against a real migrated database.
 *
 * Skips unless TEST_DATABASE_URL points at a database already migrated to head (the workers test
 * convention -- see attendance-alert.test.ts).
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { releasedLine, notifySchoolEvents } from "../school-events";

import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

let sql: Sql;

beforeAll(() => {
  if (!databaseUrl) return;
  sql = postgres(databaseUrl, { max: 4, idle_timeout: 20, prepare: false });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

interface Fixture {
  schoolId: string;
  yearId: string;
  termId: string;
  sectionId: string;
  subjectId: string;
  /** Amina: student account and a linked parent; has marks. */
  aminaId: string;
  aminaUserId: string;
  parentUserId: string;
  /** Badr: student account, no parent; has marks. */
  badrUserId: string;
  /** Dana: placed in the section but no mark in the subject. */
  danaUserId: string;
  firstExamId: string;
  secondExamId: string;
  adminUserId: string;
}

let seq = 0;

/** One section of one grade, Mathematics with two term exams, three placed students. */
async function seed(): Promise<Fixture> {
  seq += 1;
  const tag = `marks${seq}-${Date.now().toString(36)}`;
  return await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const email = `${tag}@admin.local`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${tag}, ${`Marks ${tag}`}, ${email}, ${email}, ${reference!.country}, ${reference!.currency})
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const user = async (prefix: string, name: string) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
        VALUES (${schoolId}::uuid, ${`${prefix}-${tag}@t.local`}, ${`${prefix}-${tag}@t.local`},
                ${name}, 'active')
        RETURNING id
      `;
      return row!.id;
    };
    const student = async (userId: string, first: string, n: number) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
        VALUES (${schoolId}::uuid, ${userId}::uuid, ${`ADM-${tag}-${n}`}, ${first}, 'Tazi', 'enrolled')
        RETURNING id
      `;
      return row!.id;
    };
    const aminaUserId = await user("s1", "Amina");
    const badrUserId = await user("s2", "Badr");
    const danaUserId = await user("s3", "Dana");
    const parentUserId = await user("p", "Parent");
    const adminUserId = await user("a", "Admin");
    const aminaId = await student(aminaUserId, "Amina", 1);
    const badrId = await student(badrUserId, "Badr", 2);
    const danaId = await student(danaUserId, "Dana", 3);

    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}::uuid, 'Tazi family', ${parentUserId}::uuid)
      RETURNING id
    `;
    await tx`
      INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${schoolId}::uuid, ${family!.id}::uuid, ${parentUserId}::uuid, ${aminaId}::uuid, 'guardian')
    `;

    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, ${`Y-${tag}`}, ${`Year ${tag}`}, '2026-06-01', '2027-05-31', 'active')
      RETURNING id
    `;
    const yearId = year!.id;
    const [term] = await tx<{ id: string }[]>`
      INSERT INTO app.terms
        (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, ${yearId}::uuid, ${`T-${tag}`}, 'Term 1', 1::smallint,
              '2026-06-01', '2026-12-31', 'active')
      RETURNING id
    `;
    const termId = term!.id;
    const [subject] = await tx<{ id: string }[]>`
      INSERT INTO app.subjects (school_id, code, name, status)
      VALUES (${schoolId}::uuid, ${`M-${tag}`}, 'Mathematics', 'active') RETURNING id
    `;
    const subjectId = subject!.id;
    const [grade] = await tx<{ id: string }[]>`
      INSERT INTO app.grade_levels (school_id, name, sort_order)
      VALUES (${schoolId}::uuid, 'Grade 7', 7) RETURNING id
    `;
    const [section] = await tx<{ id: string }[]>`
      INSERT INTO app.sections (school_id, academic_year_id, grade_level_id, name)
      VALUES (${schoolId}::uuid, ${yearId}::uuid, ${grade!.id}::uuid, '7A') RETURNING id
    `;
    const sectionId = section!.id;
    for (const studentId of [aminaId, badrId, danaId]) {
      await tx`
        INSERT INTO app.student_sections (school_id, student_id, academic_year_id, section_id)
        VALUES (${schoolId}::uuid, ${studentId}::uuid, ${yearId}::uuid, ${sectionId}::uuid)
      `;
    }
    await tx`
      INSERT INTO app.grade_programs (school_id, academic_year_id, grade_level_id)
      VALUES (${schoolId}::uuid, ${yearId}::uuid, ${grade!.id}::uuid)
    `;
    const [config] = await tx<{ id: string }[]>`
      INSERT INTO app.subject_configs (school_id, academic_year_id, grade_level_id, subject_id)
      VALUES (${schoolId}::uuid, ${yearId}::uuid, ${grade!.id}::uuid, ${subjectId}::uuid)
      RETURNING id
    `;
    const [category] = await tx<{ id: string }[]>`
      INSERT INTO app.subject_config_categories (school_id, subject_config_id, name, kind, scope)
      VALUES (${schoolId}::uuid, ${config!.id}::uuid, 'Exams', 'exam', 'term') RETURNING id
    `;
    const assessment = async (name: string) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.subject_config_assessments
          (school_id, subject_config_id, academic_year_id, category_id, term_id, name, max_marks)
        VALUES (${schoolId}::uuid, ${config!.id}::uuid, ${yearId}::uuid, ${category!.id}::uuid,
                ${termId}::uuid, ${name}, 50)
        RETURNING id
      `;
      return row!.id;
    };
    const firstExamId = await assessment("First exam");
    const secondExamId = await assessment("Second exam");
    for (const [studentId, assessmentId, score] of [
      [aminaId, firstExamId, 44],
      [badrId, firstExamId, 38],
      [aminaId, secondExamId, 40],
    ] as const) {
      await tx`
        INSERT INTO app.student_marks
          (school_id, academic_year_id, assessment_id, student_id, attempt, status, score, entered_by_user_id)
        VALUES (${schoolId}::uuid, ${yearId}::uuid, ${assessmentId}::uuid, ${studentId}::uuid, 1,
                'graded', ${score}, ${adminUserId}::uuid)
      `;
    }

    return {
      schoolId,
      yearId,
      termId,
      sectionId,
      subjectId,
      aminaId,
      aminaUserId,
      parentUserId,
      badrUserId,
      danaUserId,
      firstExamId,
      secondExamId,
      adminUserId,
    };
  });
}

async function asAdmin<T>(schoolId: string, fn: (tx: postgres.TransactionSql) => Promise<T>) {
  return await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx);
  });
}

/** An approved single-assessment release, as decideAssessmentRelease leaves it. */
async function approveRelease(f: Fixture, assessmentId: string) {
  await asAdmin(
    f.schoolId,
    (tx) => tx`
    INSERT INTO app.assessment_mark_releases (
      school_id, academic_year_id, section_id, subject_id, term_id, assessment_id, status,
      submitted_by_user_id, submitted_at, decided_by_user_id, decided_at
    ) VALUES (
      ${f.schoolId}::uuid, ${f.yearId}::uuid, ${f.sectionId}::uuid, ${f.subjectId}::uuid,
      ${f.termId}::uuid, ${assessmentId}::uuid, 'approved', ${f.adminUserId}::uuid,
      CURRENT_TIMESTAMP, ${f.adminUserId}::uuid, CURRENT_TIMESTAMP
    )
  `,
  );
}

async function approveSheet(f: Fixture) {
  await asAdmin(
    f.schoolId,
    (tx) => tx`
    INSERT INTO app.mark_sheets (
      school_id, academic_year_id, section_id, subject_id, term_id, status,
      submitted_by_user_id, submitted_at, decided_by_user_id, decided_at
    ) VALUES (
      ${f.schoolId}::uuid, ${f.yearId}::uuid, ${f.sectionId}::uuid, ${f.subjectId}::uuid,
      ${f.termId}::uuid, 'approved', ${f.adminUserId}::uuid, CURRENT_TIMESTAMP,
      ${f.adminUserId}::uuid, CURRENT_TIMESTAMP
    )
  `,
  );
}

async function emitReleased(f: Fixture, assessmentId: string | null) {
  await asAdmin(
    f.schoolId,
    (tx) => tx`
    INSERT INTO app.outbox_events (school_id, event_name, payload)
    VALUES (${f.schoolId}::uuid, 'marks.released', ${tx.json({
      sectionId: f.sectionId,
      subjectId: f.subjectId,
      termId: f.termId,
      assessmentId,
    })})
  `,
  );
}

async function inbox(schoolId: string) {
  return asAdmin(
    schoolId,
    (tx) => tx<
      {
        user_id: string;
        notification_type: string;
        title: string;
        body: string;
        metadata: Record<string, string>;
      }[]
    >`
    SELECT user_id, notification_type::text AS notification_type, title, body, metadata
    FROM app.notifications
    WHERE school_id = ${schoolId}::uuid
    ORDER BY user_id
  `,
  );
}

describe("releasedLine", () => {
  test("names one assessment, or a whole period", () => {
    const one = { subjectName: "Mathematics", termName: "Term 1", assessmentName: "First exam" };
    expect(releasedLine("en", one)).toBe("First exam marks are out for Mathematics");
    expect(releasedLine("ar", one)).toBe("صدرت درجات First exam في Mathematics");
    const sheet = { subjectName: "Mathematics", termName: "Term 1", assessmentName: null };
    expect(releasedLine("en", sheet)).toBe("Mathematics – Term 1 marks are released");
    expect(releasedLine("en", { ...sheet, termName: null })).toBe(
      "Mathematics – Full year marks are released",
    );
  });
});

describeDb("marks released notices", () => {
  test("one released assessment tells each student with a mark and their parents, once", async () => {
    const f = await seed();
    await approveRelease(f, f.firstExamId);
    await emitReleased(f, f.firstExamId);

    // Amina, her parent and Badr; Dana has no First exam mark.
    expect(await notifySchoolEvents(sql, f.schoolId, 50)).toEqual({
      events: 1,
      notifications: 3,
    });
    const rows = await inbox(f.schoolId);
    const byUser = new Map(rows.map((row) => [row.user_id, row]));
    expect(byUser.has(f.danaUserId)).toBe(false);
    expect(byUser.get(f.aminaUserId)).toMatchObject({
      notification_type: "MARKS_RELEASED",
      title: "Marks released: Mathematics",
      body: "First exam marks are out for Mathematics",
      metadata: {
        route: `/students/${f.aminaId}/marks`,
        student_id: f.aminaId,
        section_id: f.sectionId,
        subject_id: f.subjectId,
        term_id: f.termId,
        assessment_id: f.firstExamId,
      },
    });
    expect(byUser.get(f.parentUserId)).toMatchObject({
      body: "Amina Tazi · First exam marks are out for Mathematics",
      metadata: { route: `/students/${f.aminaId}/marks`, student_id: f.aminaId },
    });

    // Consumed: nothing more on the next pass.
    expect(await notifySchoolEvents(sql, f.schoolId, 50)).toEqual({ events: 0, notifications: 0 });
  });

  test("an approved term sheet sends one notice per person for the subject", async () => {
    const f = await seed();
    await approveSheet(f);
    await emitReleased(f, null);

    expect(await notifySchoolEvents(sql, f.schoolId, 50)).toEqual({
      events: 1,
      notifications: 3,
    });
    const rows = await inbox(f.schoolId);
    expect(rows.every((row) => row.body.endsWith("Mathematics – Term 1 marks are released"))).toBe(
      true,
    );
    expect(
      rows.find((row) => row.user_id === f.aminaUserId)!.metadata.assessment_id,
    ).toBeUndefined();
  });

  test("a release withdrawn before the notice goes out sends nothing", async () => {
    const f = await seed();
    await emitReleased(f, f.secondExamId);
    expect(await notifySchoolEvents(sql, f.schoolId, 50)).toEqual({
      events: 1,
      notifications: 0,
    });
  });

  test("a parent who turned the in-app notice off gets none", async () => {
    const f = await seed();
    await asAdmin(
      f.schoolId,
      (tx) => tx`
      INSERT INTO app.notification_preferences (school_id, user_id, notification_type, channel, enabled)
      VALUES (${f.schoolId}::uuid, ${f.parentUserId}::uuid, 'MARKS_RELEASED', 'in_app', false)
      ON CONFLICT (user_id, notification_type, channel) DO UPDATE SET enabled = false
    `,
    );
    await approveRelease(f, f.firstExamId);
    await emitReleased(f, f.firstExamId);
    expect(await notifySchoolEvents(sql, f.schoolId, 50)).toEqual({
      events: 1,
      notifications: 2,
    });
  });
});
