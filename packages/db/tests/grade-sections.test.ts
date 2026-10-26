import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");
const TABLES = ["grade_levels", "sections", "student_sections"] as const;

type Database = Awaited<ReturnType<typeof testDatabase>>;
type Role = "studafy_admin" | "studafy_app";

interface Fixture {
  school: string;
  year: string;
  otherYear: string;
  term: string;
  grade: string;
  section: string;
  otherYearSection: string;
  classId: string;
  student: string;
}

async function migratedDatabase(): Promise<Database> {
  const database = await testDatabase();
  await runMigrationCommand("migrate", {
    env: runnerEnv(database.url, repositoryMigrations),
    log: () => undefined,
  });
  return database;
}

async function asRole<T>(
  database: Database,
  role: Role,
  run: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await database.sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    result = await run(tx);
  });
  return result as T;
}

async function createSchool(database: Database, slug: string): Promise<string> {
  const [refs] = await database.sql<{ country: string; currency: string }[]>`
    SELECT
      (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
      (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
  `;
  return asRole(database, "studafy_admin", async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${slug}, ${slug}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`}, ${refs!.country}, ${refs!.currency}) RETURNING id
    `;
    return row!.id;
  });
}

// One school with two academic years, a "Grade 10" with section "C" in each, a class in the first
// year, and a student. Seeded as studafy_admin: classes and students carry role_scope_visibility,
// which PostgreSQL also applies to INSERT ... RETURNING for studafy_app.
async function createFixture(database: Database, school: string): Promise<Fixture> {
  return asRole(database, "studafy_admin", async (tx) => {
    await tx`SELECT set_config('app.school_id', ${school}, true)`;
    const [teacherUser] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${school}, 'teacher@example.test', 'teacher@example.test', 'active') RETURNING id
    `;
    const [studentUser] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${school}, 'student@example.test', 'student@example.test', 'active') RETURNING id
    `;
    const [teacher] = await tx<{ id: string }[]>`
      INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
      VALUES (${school}, ${teacherUser!.id}, 'EMP-1', 'active') RETURNING id
    `;
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
      VALUES (${school}, ${studentUser!.id}, 'ADM-1', 'Sara', 'Ali') RETURNING id
    `;
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${school}, 'AY-1', '2026-2027', '2026-08-01', '2027-06-30', 'planned') RETURNING id
    `;
    const [otherYear] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${school}, 'AY-2', '2027-2028', '2027-08-01', '2028-06-30', 'planned') RETURNING id
    `;
    const [term] = await tx<{ id: string }[]>`
      INSERT INTO app.terms
        (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
      VALUES (${school}, ${year!.id}, 'T-1', 'Term 1', 1, '2026-08-15', '2026-12-20', 'active')
      RETURNING id
    `;
    const [subject] = await tx<{ id: string }[]>`
      INSERT INTO app.subjects (school_id, code, name, status)
      VALUES (${school}, 'MATH', 'Mathematics', 'active') RETURNING id
    `;
    const [course] = await tx<{ id: string }[]>`
      INSERT INTO app.courses (school_id, subject_id, code, name, status)
      VALUES (${school}, ${subject!.id}, 'MATH-10', 'Math 10', 'active') RETURNING id
    `;
    const [room] = await tx<{ id: string }[]>`
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building, floor)
      VALUES (${school}, 'R-1', 'Room 1', 'physical', 30, 'Main', '1') RETURNING id
    `;
    const [grade] = await tx<{ id: string }[]>`
      INSERT INTO app.grade_levels (school_id, name, sort_order)
      VALUES (${school}, 'Grade 10', 10) RETURNING id
    `;
    const [section] = await tx<{ id: string }[]>`
      INSERT INTO app.sections (school_id, academic_year_id, grade_level_id, name)
      VALUES (${school}, ${year!.id}, ${grade!.id}, 'C') RETURNING id
    `;
    const [otherYearSection] = await tx<{ id: string }[]>`
      INSERT INTO app.sections (school_id, academic_year_id, grade_level_id, name)
      VALUES (${school}, ${otherYear!.id}, ${grade!.id}, 'C') RETURNING id
    `;
    const [classRow] = await tx<{ id: string }[]>`
      INSERT INTO app.classes
        (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, section_id,
         code, capacity, status)
      VALUES (${school}, ${course!.id}, ${year!.id}, ${term!.id}, ${teacher!.id}, ${room!.id},
        ${section!.id}, 'MATH-10C', 30, 'active') RETURNING id
    `;
    return {
      school,
      year: year!.id,
      otherYear: otherYear!.id,
      term: term!.id,
      grade: grade!.id,
      section: section!.id,
      otherYearSection: otherYearSection!.id,
      classId: classRow!.id,
      student: student!.id,
    };
  });
}

async function expectSqlState(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect((caught as { code?: string } | undefined)?.code).toBe(code);
}

integrationTest("installs grade levels, sections, and placements with forced RLS", async () => {
  const database = await migratedDatabase();
  try {
    const tables = await database.sql<
      { name: string; owner: string; rls: boolean; forced: boolean }[]
    >`
      SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
             c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_class c
      WHERE c.relnamespace = 'app'::regnamespace AND c.relname = ANY(${TABLES as unknown as string[]})
      ORDER BY c.relname
    `;
    expect([...tables]).toEqual([
      { name: "grade_levels", owner: "studafy_admin", rls: true, forced: true },
      { name: "sections", owner: "studafy_admin", rls: true, forced: true },
      { name: "student_sections", owner: "studafy_admin", rls: true, forced: true },
    ]);

    const policies = await database.sql<{ table: string; name: string }[]>`
      SELECT tablename AS table, policyname AS name FROM pg_policies
      WHERE schemaname = 'app' AND tablename = ANY(${TABLES as unknown as string[]})
      ORDER BY tablename, policyname
    `;
    expect([...policies]).toEqual([
      { table: "grade_levels", name: "tenant_isolation" },
      { table: "sections", name: "tenant_isolation" },
      { table: "student_sections", name: "role_scope_visibility" },
      { table: "student_sections", name: "tenant_isolation" },
    ]);
  } finally {
    await database.cleanup();
  }
});

integrationTest("pins classes and placements to sections of their own academic year", async () => {
  const database = await migratedDatabase();
  try {
    const school = await createSchool(database, "sections-integrity");
    const fx = await createFixture(database, school);

    await asRole(database, "studafy_admin", async (tx) => {
      await tx`SELECT set_config('app.school_id', ${school}, true)`;

      // A class of year 1 cannot be taught to a section of year 2.
      await expectSqlState(
        tx.savepoint(
          (sp) => sp`
          UPDATE app.classes SET section_id = ${fx.otherYearSection} WHERE id = ${fx.classId}
        `,
        ),
        "23503",
      );

      // Placement must match the section's year...
      await expectSqlState(
        tx.savepoint(
          (sp) => sp`
          INSERT INTO app.student_sections (school_id, student_id, academic_year_id, section_id)
          VALUES (${school}, ${fx.student}, ${fx.year}, ${fx.otherYearSection})
        `,
        ),
        "23503",
      );

      // ...and a student sits in one section per year.
      await tx`
        INSERT INTO app.student_sections (school_id, student_id, academic_year_id, section_id)
        VALUES (${school}, ${fx.student}, ${fx.year}, ${fx.section})
      `;
      const [secondSection] = await tx<{ id: string }[]>`
        INSERT INTO app.sections (school_id, academic_year_id, grade_level_id, name)
        VALUES (${school}, ${fx.year}, ${fx.grade}, 'D') RETURNING id
      `;
      await expectSqlState(
        tx.savepoint(
          (sp) => sp`
          INSERT INTO app.student_sections (school_id, student_id, academic_year_id, section_id)
          VALUES (${school}, ${fx.student}, ${fx.year}, ${secondSection!.id})
        `,
        ),
        "23505",
      );

      // Section names are unique within a grade and year, not across years.
      await expectSqlState(
        tx.savepoint(
          (sp) => sp`
          INSERT INTO app.sections (school_id, academic_year_id, grade_level_id, name)
          VALUES (${school}, ${fx.year}, ${fx.grade}, 'C')
        `,
        ),
        "23505",
      );
    });
  } finally {
    await database.cleanup();
  }
});

integrationTest("isolates tenants and scopes placements to who can read the student", async () => {
  const database = await migratedDatabase();
  try {
    const schoolA = await createSchool(database, "sections-a");
    const schoolB = await createSchool(database, "sections-b");
    const fxA = await createFixture(database, schoolA);
    await createFixture(database, schoolB);

    await asRole(database, "studafy_admin", async (tx) => {
      await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
      await tx`
        INSERT INTO app.student_sections (school_id, student_id, academic_year_id, section_id)
        VALUES (${schoolA}, ${fxA.student}, ${fxA.year}, ${fxA.section})
      `;
    });

    // A school member with no relationship to the student: sees the school's grade and section
    // names (they label lessons), never another school's, and not who is placed where.
    await asRole(database, "studafy_app", async (tx) => {
      await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
      await tx`SELECT set_config('app.user_id', '00000000-0000-0000-0000-000000000001', true)`;

      const sections = await tx<{ school_id: string }[]>`SELECT school_id FROM app.sections`;
      expect(sections.length).toBe(2);
      expect(sections.every((row) => row.school_id === schoolA)).toBe(true);

      const grades = await tx`SELECT id FROM app.grade_levels`;
      expect(grades.length).toBe(1);

      const placements = await tx`SELECT id FROM app.student_sections`;
      expect(placements.length).toBe(0);
    });

    // The student themselves can read their own placement.
    await asRole(database, "studafy_app", async (tx) => {
      await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
      const [studentUser] = await database.sql<{ user_id: string }[]>`
        SELECT user_id FROM app.students WHERE id = ${fxA.student}
      `;
      await tx`SELECT set_config('app.user_id', ${studentUser!.user_id}, true)`;
      const placements = await tx<{ section_id: string }[]>`
        SELECT section_id FROM app.student_sections
      `;
      expect([...placements]).toEqual([{ section_id: fxA.section }]);
    });
  } finally {
    await database.cleanup();
  }
});
