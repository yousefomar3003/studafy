import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");
const TABLES = [
  "assignments",
  "assignment_submissions",
  "exams",
  "exam_results",
  "materials",
] as const;

type Database = Awaited<ReturnType<typeof testDatabase>>;
type Role = "studafy_admin" | "studafy_app";

interface Fixture {
  school: string;
  staffUser: string;
  studentUser: string;
  secondStudentUser: string;
  student: string;
  secondStudent: string;
  classId: string;
  assignment: string;
  submission: string;
  exam: string;
  result: string;
  material: string;
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

async function expectDenied(
  database: Database,
  statement: string,
  context?: string,
  role: Role = "studafy_app",
): Promise<void> {
  await asRole(database, role, async (tx) => {
    if (context !== undefined) await tx`SELECT set_config('app.school_id', ${context}, true)`;
    await tx.unsafe(`
      DO $expected_error$
      DECLARE failed boolean := false;
      BEGIN
        BEGIN EXECUTE $statement$${statement}$statement$;
        EXCEPTION WHEN OTHERS THEN failed := true;
        END;
        IF NOT failed THEN RAISE EXCEPTION 'expected statement to fail'; END IF;
      END
      $expected_error$
    `);
  });
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

async function createFixture(database: Database, school: string, suffix: string): Promise<Fixture> {
  // ST-085: several tables this fixture seeds (students, subjects, courses, classes, assignments,
  // exams, materials, ...) now carry a restrictive role_scope_visibility SELECT policy, which
  // PostgreSQL also applies to INSERT ... RETURNING. Seed as studafy_admin (still bound by
  // tenant_isolation, exempt from the TO studafy_app scope policy) so the fixture writes are not
  // filtered by a per-user read scope it has no authenticated user for.
  return asRole(database, "studafy_admin", async (tx) => {
    await tx`SELECT set_config('app.school_id', ${school}, true)`;
    const lower = suffix.toLowerCase();
    const [staff] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${school}, ${`staff-${lower}@example.test`}, ${`staff-${lower}@example.test`}, 'active')
      RETURNING id
    `;
    const [teacherUser] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${school}, ${`teacher-${lower}@example.test`},
        ${`teacher-${lower}@example.test`}, 'active') RETURNING id
    `;
    const [studentUser] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${school}, ${`student-${lower}@example.test`},
        ${`student-${lower}@example.test`}, 'active') RETURNING id
    `;
    const [secondStudentUser] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${school}, ${`student-2-${lower}@example.test`},
        ${`student-2-${lower}@example.test`}, 'active') RETURNING id
    `;
    const [teacher] = await tx<{ id: string }[]>`
      INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
      VALUES (${school}, ${teacherUser!.id}, ${`EMP-${suffix}`}, 'active') RETURNING id
    `;
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
      VALUES (${school}, ${studentUser!.id}, ${`STU-${suffix}`}, 'First', 'Student') RETURNING id
    `;
    const [secondStudent] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
      VALUES (${school}, ${secondStudentUser!.id}, ${`STU-2-${suffix}`}, 'Second', 'Student')
      RETURNING id
    `;
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${school}, ${`AY-${suffix}`}, 'Academic Year', '2026-08-01', '2027-06-30', 'planned')
      RETURNING id
    `;
    const [term] = await tx<{ id: string }[]>`
      INSERT INTO app.terms
        (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
      VALUES (${school}, ${year!.id}, ${`TERM-${suffix}`}, 'First Term', 1,
        '2026-08-15', '2026-12-20', 'planned') RETURNING id
    `;
    const [subject] = await tx<{ id: string }[]>`
      INSERT INTO app.subjects (school_id, code, name, status)
      VALUES (${school}, ${`SUB-${suffix}`}, 'Mathematics', 'active') RETURNING id
    `;
    const [course] = await tx<{ id: string }[]>`
      INSERT INTO app.courses (school_id, subject_id, code, name, status)
      VALUES (${school}, ${subject!.id}, ${`COURSE-${suffix}`}, 'Algebra', 'active') RETURNING id
    `;
    const [room] = await tx<{ id: string }[]>`
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building)
      VALUES (${school}, ${`ROOM-${suffix}`}, 'Room', 'physical', 30, 'Main') RETURNING id
    `;
    const [classRow] = await tx<{ id: string }[]>`
      INSERT INTO app.classes
        (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id,
         code, capacity, status)
      VALUES (${school}, ${course!.id}, ${year!.id}, ${term!.id}, ${teacher!.id}, ${room!.id},
        ${`CLASS-${suffix}`}, 25, 'active') RETURNING id
    `;
    await tx`
      INSERT INTO app.enrollments (school_id, class_id, student_id)
      VALUES (${school}, ${classRow!.id}, ${student!.id}),
        (${school}, ${classRow!.id}, ${secondStudent!.id})
    `;
    const [assignment] = await tx<{ id: string }[]>`
      INSERT INTO app.assignments
        (school_id, class_id, created_by_user_id, last_edited_by_user_id, title,
         status, available_from, assigned_at, due_at, max_score)
      VALUES (${school}, ${classRow!.id}, ${staff!.id}, ${staff!.id}, 'Algebra worksheet',
        'published', '2026-09-01', '2026-09-01', '2026-09-10', 100) RETURNING id
    `;
    const [submission] = await tx<{ id: string }[]>`
      INSERT INTO app.assignment_submissions
        (school_id, assignment_id, student_id, last_edited_by_user_id, status, submitted_at)
      VALUES (${school}, ${assignment!.id}, ${student!.id}, ${studentUser!.id},
        'submitted', '2026-09-09') RETURNING id
    `;
    const [exam] = await tx<{ id: string }[]>`
      INSERT INTO app.exams
        (school_id, class_id, created_by_user_id, last_edited_by_user_id, title,
         status, starts_at, ends_at, max_score)
      VALUES (${school}, ${classRow!.id}, ${staff!.id}, ${staff!.id}, 'Midterm exam',
        'scheduled', '2026-10-01 09:00+00', '2026-10-01 11:00+00', 100) RETURNING id
    `;
    const [result] = await tx<{ id: string }[]>`
      INSERT INTO app.exam_results
        (school_id, exam_id, student_id, last_edited_by_user_id)
      VALUES (${school}, ${exam!.id}, ${student!.id}, ${staff!.id}) RETURNING id
    `;
    const objectId = crypto.randomUUID();
    const [material] = await tx<{ id: string }[]>`
      INSERT INTO app.materials
        (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title,
         storage_key, original_file_name, mime_type, size_bytes)
      VALUES (${school}, ${classRow!.id}, ${staff!.id}, ${staff!.id}, 'Chapter notes',
        ${`permanent/${school}/${objectId}/chapter.pdf`}, 'chapter.pdf', 'application/pdf', 4096)
      RETURNING id
    `;
    return {
      school,
      staffUser: staff!.id,
      studentUser: studentUser!.id,
      secondStudentUser: secondStudentUser!.id,
      student: student!.id,
      secondStudent: secondStudent!.id,
      classId: classRow!.id,
      assignment: assignment!.id,
      submission: submission!.id,
      exam: exam!.id,
      result: result!.id,
      material: material!.id,
    };
  });
}

integrationTest(
  "installs assessment/content tables, enums, ownership, grants, policies, and validates twice",
  async () => {
    const database = await migratedDatabase();
    try {
      await runMigrationCommand("migrate", {
        env: runnerEnv(database.url, repositoryMigrations),
        log: () => undefined,
      });
      await runMigrationCommand("validate", {
        env: runnerEnv(database.url, repositoryMigrations),
        log: () => undefined,
      });
      await runMigrationCommand("status", {
        env: runnerEnv(database.url, repositoryMigrations),
        log: () => undefined,
      });

      const enums = await database.sql<{ name: string; values: string[] }[]>`
        SELECT t.typname AS name,
          array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE n.nspname = 'app' AND t.typname = ANY(${[
          "assignment_status",
          "assignment_submission_status",
          "exam_status",
          "exam_result_status",
          "material_ingest_status",
        ]})
        GROUP BY t.typname ORDER BY t.typname
      `;
      expect(Object.fromEntries(enums.map((row) => [row.name, row.values]))).toEqual({
        assignment_status: ["draft", "published", "closed", "archived"],
        assignment_submission_status: [
          "draft",
          "submitted",
          "late",
          "graded",
          "returned",
          "withdrawn",
        ],
        exam_result_status: ["pending", "graded", "published", "withheld", "voided"],
        exam_status: ["draft", "scheduled", "open", "closed", "cancelled", "archived"],
        material_ingest_status: [
          "uploaded",
          "processing",
          "ready",
          "failed",
          "scanning",
          "quarantined",
          "queued",
        ],
      });

      const tables = await database.sql<
        {
          name: string;
          owner: string;
          rls: boolean;
          forced: boolean;
          appCrud: boolean;
          publicAccess: boolean;
        }[]
      >`
        SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
          c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
          has_table_privilege('studafy_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS "appCrud",
          has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS "publicAccess"
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY(${TABLES as unknown as string[]})
        ORDER BY c.relname
      `;
      expect(tables.map((row) => row.name)).toEqual([...TABLES].sort());
      expect(
        tables.every(
          (row) =>
            row.owner === "studafy_admin" &&
            row.rls &&
            row.forced &&
            row.appCrud &&
            !row.publicAccess,
        ),
      ).toBe(true);

      const policies = await database.sql<
        { tableName: string; name: string; using: string; check: string }[]
      >`
        SELECT c.relname AS "tableName", p.polname AS name,
          pg_get_expr(p.polqual, p.polrelid) AS using,
          pg_get_expr(p.polwithcheck, p.polrelid) AS check
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relnamespace = 'app'::regnamespace
          AND c.relname = ANY(${TABLES as unknown as string[]})
        ORDER BY c.relname
      `;
      // Every assessment/content table carries the permissive tenant_isolation policy. ST-085 layers
      // the restrictive role_scope_visibility SELECT policy onto each of them as well.
      const tenantPolicies = policies.filter((policy) => policy.name === "tenant_isolation");
      const scopePolicies = policies.filter((policy) => policy.name === "role_scope_visibility");
      expect(tenantPolicies).toHaveLength(5);
      for (const policy of tenantPolicies) {
        expect(policy.using).toContain("current_setting('app.school_id'::text)");
        expect(policy.check).toContain("current_setting('app.school_id'::text)");
      }
      expect(scopePolicies.map((policy) => policy.tableName).sort()).toEqual([...TABLES].sort());
      for (const policy of scopePolicies) {
        expect(policy.check).toBeNull();
      }
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "enforces assignment, submission, exam, and result constraints and tenant-safe relationships",
  async () => {
    const database = await migratedDatabase();
    try {
      const schoolA = await createSchool(database, "assessment-integrity-a");
      const schoolB = await createSchool(database, "assessment-integrity-b");
      const a = await createFixture(database, schoolA, "INT-A");
      const b = await createFixture(database, schoolB, "INT-B");

      await expectDenied(
        database,
        `INSERT INTO app.assignments
          (school_id,class_id,created_by_user_id,last_edited_by_user_id,title,due_at,max_score)
         VALUES ('${schoolA}','${b.classId}','${a.staffUser}','${a.staffUser}',
          'Cross school','2026-09-10',10)`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.assignments
          (school_id,class_id,created_by_user_id,last_edited_by_user_id,title,
           available_from,due_at,max_score)
         VALUES ('${schoolA}','${a.classId}','${a.staffUser}','${a.staffUser}',
          'Bad timing','2026-09-02','2026-09-01',10)`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.assignments
          (school_id,class_id,created_by_user_id,last_edited_by_user_id,title,due_at,max_score)
         VALUES ('${schoolA}','${a.classId}','${a.staffUser}','${a.staffUser}',
          'Negative score','2026-09-10',-1)`,
        schoolA,
      );
      await expectDenied(
        database,
        `UPDATE app.assignments SET status = 'bogus' WHERE id = '${a.assignment}'`,
        schoolA,
      );

      await expectDenied(
        database,
        `INSERT INTO app.assignment_submissions
          (school_id,assignment_id,student_id,last_edited_by_user_id,status,submitted_at)
         VALUES ('${schoolA}','${a.assignment}','${a.student}','${a.studentUser}',
          'submitted','2026-09-09')`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.assignment_submissions
          (school_id,assignment_id,student_id,last_edited_by_user_id)
         VALUES ('${schoolA}','${b.assignment}','${a.student}','${a.studentUser}')`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.assignment_submissions
          (school_id,assignment_id,student_id,last_edited_by_user_id)
         VALUES ('${schoolA}','${a.assignment}','${b.student}','${a.studentUser}')`,
        schoolA,
      );
      // ST-085: role_scope_visibility (a SELECT policy) also gates which existing rows an UPDATE can
      // see. A userless studafy_app matches zero rows and never reaches the CHECK/tenant guard, so
      // run these existing-row denials as studafy_admin (sees the row via tenant_isolation only).
      await expectDenied(
        database,
        `UPDATE app.assignment_submissions
         SET status='graded',score=-1,graded_at='2026-09-10',graded_by_user_id='${a.staffUser}'
         WHERE id='${a.submission}'`,
        schoolA,
        "studafy_admin",
      );
      // ST-085: this block INSERTs into scoped tables with RETURNING and must read them back, so run
      // as studafy_admin (exempt from role_scope_visibility, still bound by tenant_isolation).
      await asRole(database, "studafy_admin", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`
          INSERT INTO app.assignment_submissions
            (school_id, assignment_id, student_id, last_edited_by_user_id)
          VALUES (${schoolA}, ${a.assignment}, ${a.secondStudent}, ${a.secondStudentUser})
        `;
        const [secondAssignment] = await tx<{ id: string }[]>`
          INSERT INTO app.assignments
            (school_id, class_id, created_by_user_id, last_edited_by_user_id,
             title, due_at, max_score)
          VALUES (${schoolA}, ${a.classId}, ${a.staffUser}, ${a.staffUser},
            'Second assignment', '2026-09-20', 50) RETURNING id
        `;
        await tx`
          INSERT INTO app.assignment_submissions
            (school_id, assignment_id, student_id, last_edited_by_user_id)
          VALUES (${schoolA}, ${secondAssignment!.id}, ${a.student}, ${a.studentUser})
        `;
      });
      await expectDenied(
        database,
        `UPDATE app.assignment_submissions SET status='invented' WHERE id='${a.submission}'`,
        schoolA,
        "studafy_admin",
      );

      await expectDenied(
        database,
        `INSERT INTO app.exams
          (school_id,class_id,created_by_user_id,last_edited_by_user_id,title,
           starts_at,ends_at,max_score)
         VALUES ('${schoolA}','${b.classId}','${a.staffUser}','${a.staffUser}',
          'Cross exam','2026-10-01','2026-10-02',100)`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.exams
          (school_id,class_id,created_by_user_id,last_edited_by_user_id,title,
           starts_at,ends_at,max_score)
         VALUES ('${schoolA}','${a.classId}','${a.staffUser}','${a.staffUser}',
          'Bad exam','2026-10-02','2026-10-01',100)`,
        schoolA,
      );
      await expectDenied(
        database,
        `UPDATE app.exams SET max_score=-1 WHERE id='${a.exam}'`,
        schoolA,
        "studafy_admin",
      );
      await expectDenied(
        database,
        `UPDATE app.exams SET status='invented' WHERE id='${a.exam}'`,
        schoolA,
        "studafy_admin",
      );

      await expectDenied(
        database,
        `INSERT INTO app.exam_results
          (school_id,exam_id,student_id,last_edited_by_user_id)
         VALUES ('${schoolA}','${a.exam}','${a.student}','${a.staffUser}')`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.exam_results
          (school_id,exam_id,student_id,last_edited_by_user_id)
         VALUES ('${schoolA}','${b.exam}','${a.student}','${a.staffUser}')`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.exam_results
          (school_id,exam_id,student_id,last_edited_by_user_id)
         VALUES ('${schoolA}','${a.exam}','${b.student}','${a.staffUser}')`,
        schoolA,
      );
      await expectDenied(
        database,
        `UPDATE app.exam_results
         SET status='graded',score=-1,graded_at='2026-10-02',graded_by_user_id='${a.staffUser}'
         WHERE id='${a.result}'`,
        schoolA,
        "studafy_admin",
      );
      await expectDenied(
        database,
        `UPDATE app.exam_results SET status='invented' WHERE id='${a.result}'`,
        schoolA,
        "studafy_admin",
      );
      // ST-085: inserts into and updates existing scoped exam_results rows, so run as studafy_admin.
      await asRole(database, "studafy_admin", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`
          INSERT INTO app.exam_results
            (school_id, exam_id, student_id, last_edited_by_user_id)
          VALUES (${schoolA}, ${a.exam}, ${a.secondStudent}, ${a.staffUser})
        `;
        await tx`
          UPDATE app.exam_results
          SET status='graded', score=88.50, graded_at='2026-10-02',
            graded_by_user_id=${a.staffUser}
          WHERE id=${a.result}
        `;
        await tx`
          UPDATE app.exam_results
          SET status='published', published_at='2026-10-03',
            published_by_user_id=${a.staffUser}
          WHERE id=${a.result}
        `;
      });
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "enforces material storage, ingestion, AI, and class-parent rules",
  async () => {
    const database = await migratedDatabase();
    try {
      const schoolA = await createSchool(database, "material-integrity-a");
      const schoolB = await createSchool(database, "material-integrity-b");
      const a = await createFixture(database, schoolA, "MAT-A");
      const b = await createFixture(database, schoolB, "MAT-B");

      // ST-085: reads back the scoped app.materials row, so run as studafy_admin.
      const [defaults] = await asRole(database, "studafy_admin", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        return tx<{ aiVisible: boolean; status: string }[]>`
        SELECT ai_visible AS "aiVisible", ingest_status::text AS status
        FROM app.materials WHERE id = ${a.material}
      `;
      });
      expect(defaults).toEqual({ aiVisible: false, status: "uploaded" });

      const base = `(school_id,class_id,uploaded_by_user_id,last_edited_by_user_id,title,
      storage_key,original_file_name,mime_type,size_bytes)`;
      await expectDenied(
        database,
        `INSERT INTO app.materials ${base}
       VALUES ('${schoolA}','${b.classId}','${a.staffUser}','${a.staffUser}','Cross class',
        'permanent/${schoolA}/${crypto.randomUUID()}/cross.pdf','cross.pdf','application/pdf',1)`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.materials ${base}
       VALUES ('${schoolA}','${a.classId}','${a.staffUser}','${a.staffUser}','Temporary',
        'temp/${schoolA}/${crypto.randomUUID()}/temp.pdf','temp.pdf','application/pdf',1)`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.materials ${base}
       VALUES ('${schoolA}','${a.classId}','${a.staffUser}','${a.staffUser}','Wrong tenant key',
        'permanent/${schoolB}/${crypto.randomUUID()}/wrong.pdf','wrong.pdf','application/pdf',1)`,
        schoolA,
      );
      await expectDenied(
        database,
        `UPDATE app.materials SET ingest_status='ready' WHERE id='${a.material}'`,
        schoolA,
        "studafy_admin",
      );
      await expectDenied(
        database,
        `UPDATE app.materials SET ingest_status='failed' WHERE id='${a.material}'`,
        schoolA,
        "studafy_admin",
      );
      await expectDenied(
        database,
        `UPDATE app.materials SET ingest_status='invented' WHERE id='${a.material}'`,
        schoolA,
        "studafy_admin",
      );
      await expectDenied(
        database,
        `INSERT INTO app.materials
        (school_id,class_id,uploaded_by_user_id,last_edited_by_user_id,title,
         storage_key,original_file_name,mime_type,size_bytes)
       SELECT school_id,class_id,uploaded_by_user_id,last_edited_by_user_id,'Duplicate object',
         storage_key,'duplicate.pdf','application/pdf',1
       FROM app.materials WHERE id='${a.material}'`,
        schoolA,
        "studafy_admin",
      );

      // ST-085: updates and reads back the scoped app.materials row, so run as studafy_admin.
      await asRole(database, "studafy_admin", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`
        UPDATE app.materials SET ingest_status='processing' WHERE id=${a.material}
      `;
        await tx`
        UPDATE app.materials
        SET ingest_status='ready', ingested_at='2026-09-01 12:00+00', ai_visible=true
        WHERE id=${a.material}
      `;
        const [row] = await tx<{ status: string; aiVisible: boolean }[]>`
        SELECT ingest_status::text AS status, ai_visible AS "aiVisible"
        FROM app.materials WHERE id=${a.material}
      `;
        expect(row).toEqual({ status: "ready", aiVisible: true });
      });
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "forces fail-closed tenant isolation on every assessment/content table",
  async () => {
    const database = await migratedDatabase();
    try {
      const schoolA = await createSchool(database, "assessment-rls-a");
      const schoolB = await createSchool(database, "assessment-rls-b");
      const a = await createFixture(database, schoolA, "RLS-A");
      const b = await createFixture(database, schoolB, "RLS-B");

      for (const table of TABLES) {
        await expectDenied(database, `SELECT count(*) FROM app.${table}`);
        await expectDenied(database, `SELECT count(*) FROM app.${table}`, "not-a-uuid");

        await asRole(database, "studafy_app", async (tx) => {
          await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
          const [row] = await tx.unsafe<{ count: string }[]>(
            `SELECT count(*)::text AS count FROM app.${table} WHERE school_id='${schoolB}'`,
          );
          expect(row!.count).toBe("0");
          const updated = await tx.unsafe(`UPDATE app.${table} SET updated_at=updated_at
          WHERE school_id='${schoolB}'`);
          const deleted = await tx.unsafe(`DELETE FROM app.${table} WHERE school_id='${schoolB}'`);
          expect(updated.count).toBe(0);
          expect(deleted.count).toBe(0);
        });

        await expectDenied(database, `ALTER TABLE app.${table} NO FORCE ROW LEVEL SECURITY`);
        await expectDenied(database, `DROP POLICY tenant_isolation ON app.${table}`);
        await expectDenied(database, `CREATE INDEX forbidden_${table} ON app.${table} (school_id)`);
      }
      await expectDenied(database, "SELECT app.apply_tenant_isolation('app', 'assignments')");

      for (const [table, id] of [
        ["assignments", a.assignment],
        ["assignment_submissions", a.submission],
        ["exams", a.exam],
        ["exam_results", a.result],
        ["materials", a.material],
      ]) {
        // ST-085: run as studafy_admin so the existing scoped row is visible; tenant_isolation's
        // WITH CHECK still blocks moving it to another school.
        await expectDenied(
          database,
          `UPDATE app.${table} SET school_id='${schoolB}' WHERE id='${id}'`,
          schoolA,
          "studafy_admin",
        );
      }

      await expectDenied(
        database,
        `INSERT INTO app.assignments
        (school_id,class_id,created_by_user_id,last_edited_by_user_id,title,due_at,max_score)
       VALUES ('${schoolB}','${b.classId}','${b.staffUser}','${b.staffUser}',
        'Blocked assignment','2026-11-01',10)`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.assignment_submissions
        (school_id,assignment_id,student_id,last_edited_by_user_id)
       VALUES ('${schoolB}','${b.assignment}','${b.secondStudent}','${b.secondStudentUser}')`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.exams
        (school_id,class_id,created_by_user_id,last_edited_by_user_id,title,
         starts_at,ends_at,max_score)
       VALUES ('${schoolB}','${b.classId}','${b.staffUser}','${b.staffUser}',
        'Blocked exam','2026-11-01','2026-11-02',10)`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.exam_results
        (school_id,exam_id,student_id,last_edited_by_user_id)
       VALUES ('${schoolB}','${b.exam}','${b.secondStudent}','${b.staffUser}')`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.materials
        (school_id,class_id,uploaded_by_user_id,last_edited_by_user_id,title,
         storage_key,original_file_name,mime_type,size_bytes)
       VALUES ('${schoolB}','${b.classId}','${b.staffUser}','${b.staffUser}','Blocked material',
        'permanent/${schoolB}/${crypto.randomUUID()}/blocked.pdf',
        'blocked.pdf','application/pdf',1)`,
        schoolA,
      );
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "keeps the model normalized and exposes the intended indexes to query plans",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "assessment-indexes");
      const fixture = await createFixture(database, school, "IDX");

      const forbiddenColumns = await database.sql<{ tableName: string; columnName: string }[]>`
      SELECT table_name AS "tableName", column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema='app' AND table_name = ANY(${TABLES as unknown as string[]})
        AND (
          data_type IN ('ARRAY', 'json', 'jsonb', 'bytea')
          OR column_name = ANY(${[
            "student_ids",
            "submission_ids",
            "result_ids",
            "file_data",
            "file_blob",
            "signed_url",
            "access_token",
            "school_name",
            "class_name",
            "course_name",
            "submission_count",
            "average_score",
          ]})
        )
    `;
      expect(forbiddenColumns).toHaveLength(0);

      const duplicates = await database.sql<{ tableName: string; duplicateCount: string }[]>`
      SELECT c.relname AS "tableName", count(*)::text AS "duplicateCount"
      FROM pg_index i
      JOIN pg_class c ON c.oid=i.indrelid
      WHERE c.relnamespace='app'::regnamespace
        AND c.relname = ANY(${TABLES as unknown as string[]})
      GROUP BY c.relname, i.indclass, i.indkey, i.indcollation, i.indoption,
        pg_get_expr(i.indexprs, i.indrelid), pg_get_expr(i.indpred, i.indrelid)
      HAVING count(*) > 1
    `;
      expect(duplicates).toHaveLength(0);

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        await tx`
        INSERT INTO app.materials
          (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title,
           storage_key, original_file_name, mime_type, size_bytes, ingest_status)
        SELECT ${school}, ${fixture.classId}, ${fixture.staffUser}, ${fixture.staffUser},
          'Planner material ' || g,
          ${`permanent/${school}/`} || gen_random_uuid()::text || '/planner-' || g || '.pdf',
          'planner-' || g || '.pdf', 'application/pdf', 100, 'processing'
        FROM generate_series(1, 40) AS g
      `;
      });
      await database.sql.unsafe("VACUUM ANALYZE app.materials");

      // ST-085: this test verifies the index design for each query shape. Run the EXPLAIN sweep as
      // studafy_admin so the plans are not perturbed by role_scope_visibility's can_read_* filter
      // (a per-user SELECT policy on studafy_app); the index-selection assertions stay meaningful.
      await asRole(database, "studafy_admin", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        await tx.unsafe("SET LOCAL enable_seqscan = off");
        await tx.unsafe("SET LOCAL enable_bitmapscan = off");
        await tx.unsafe("SET LOCAL enable_sort = off");
        const queries = [
          [
            ["idx_assignments_school_class_due_at"],
            `SELECT school_id,class_id,due_at,id FROM app.assignments WHERE school_id='${school}'
             AND class_id='${fixture.classId}' ORDER BY due_at,id`,
          ],
          [
            [
              "uq_assignment_submissions_school_assignment_student",
              "idx_assignment_submissions_school_student_assignment",
            ],
            `SELECT school_id,assignment_id,student_id FROM app.assignment_submissions
             WHERE school_id='${school}'
             AND assignment_id='${fixture.assignment}' AND student_id='${fixture.student}'`,
          ],
          [
            ["idx_assignment_submissions_school_status_submitted_at"],
            `SELECT school_id,status,submitted_at,id FROM app.assignment_submissions
             WHERE school_id='${school}'
             AND status='submitted' AND submitted_at >= '2026-01-01' ORDER BY submitted_at,id`,
          ],
          [
            ["idx_exams_school_class_starts_at"],
            `SELECT school_id,class_id,starts_at,id FROM app.exams WHERE school_id='${school}'
             AND class_id='${fixture.classId}' ORDER BY starts_at,id`,
          ],
          [
            ["idx_exam_results_school_student_exam"],
            `SELECT school_id,student_id,exam_id FROM app.exam_results WHERE school_id='${school}'
             AND student_id='${fixture.student}' ORDER BY exam_id`,
          ],
          [
            ["idx_materials_school_ingest_status_created_at"],
            `SELECT school_id,ingest_status,created_at,id FROM app.materials WHERE school_id='${school}'
             AND ingest_status='uploaded' AND created_at >= '2026-01-01' ORDER BY created_at,id`,
          ],
        ] as const;
        for (const [indexNames, query] of queries) {
          const plan = await tx.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${query}`);
          const planText = plan.map((row) => row["QUERY PLAN"]).join("\n");
          if (!indexNames.some((indexName) => planText.includes(indexName))) {
            throw new Error(`expected one of ${indexNames.join(", ")} in plan:\n${planText}`);
          }
        }
      });
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);
