import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");
const TABLES = ["gradebooks", "grade_submissions", "grades"] as const;

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
  gradebook: string;
  submission: string;
  secondSubmission: string;
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
      INSERT INTO app.schools (slug, name, country_id, default_currency_id)
      VALUES (${slug}, ${slug}, ${refs!.country}, ${refs!.currency}) RETURNING id
    `;
    return row!.id;
  });
}

async function createFixture(database: Database, school: string, suffix: string): Promise<Fixture> {
  return asRole(database, "studafy_app", async (tx) => {
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
    const [gradebook] = await tx<{ id: string }[]>`
      INSERT INTO app.gradebooks (school_id, class_id, status)
      VALUES (${school}, ${classRow!.id}, 'draft') RETURNING id
    `;
    const [submission] = await tx<{ id: string }[]>`
      INSERT INTO app.grade_submissions
        (school_id, gradebook_id, student_id, status)
      VALUES (${school}, ${gradebook!.id}, ${student!.id}, 'draft') RETURNING id
    `;
    const [secondSubmission] = await tx<{ id: string }[]>`
      INSERT INTO app.grade_submissions
        (school_id, gradebook_id, student_id, status)
      VALUES (${school}, ${gradebook!.id}, ${secondStudent!.id}, 'draft') RETURNING id
    `;
    return {
      school,
      staffUser: staff!.id,
      studentUser: studentUser!.id,
      secondStudentUser: secondStudentUser!.id,
      student: student!.id,
      secondStudent: secondStudent!.id,
      classId: classRow!.id,
      gradebook: gradebook!.id,
      submission: submission!.id,
      secondSubmission: secondSubmission!.id,
    };
  });
}

integrationTest(
  "installs grades workflow tables, enums, ownership, grants, policies, and validates twice",
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
          "gradebook_status",
          "grade_submission_status",
        ]})
        GROUP BY t.typname ORDER BY t.typname
      `;
      expect(Object.fromEntries(enums.map((row) => [row.name, row.values]))).toEqual({
        gradebook_status: ["draft", "active", "archived"],
        grade_submission_status: ["draft", "submitted", "approved", "rejected", "published"],
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
      expect(policies).toHaveLength(3);
      for (const policy of policies) {
        expect(policy.name).toBe("tenant_isolation");
        expect(policy.using).toContain("current_setting('app.school_id'::text)");
        expect(policy.check).toContain("current_setting('app.school_id'::text)");
      }
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "enforces gradebook constraints: one per class, status values, and tenant-safe relationships",
  async () => {
    const database = await migratedDatabase();
    try {
      const schoolA = await createSchool(database, "gradebook-integrity-a");
      const schoolB = await createSchool(database, "gradebook-integrity-b");
      const a = await createFixture(database, schoolA, "GBK-A");
      const b = await createFixture(database, schoolB, "GBK-B");

      await expectDenied(
        database,
        `INSERT INTO app.gradebooks (school_id, class_id, status)
         VALUES ('${schoolA}','${b.classId}','draft')`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.gradebooks (school_id, class_id, status)
         VALUES ('${schoolA}','${a.classId}','bogus')`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.gradebooks (school_id, class_id, status)
         VALUES ('${schoolA}','${a.classId}','draft')`,
        schoolA,
      );

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        const [row] = await tx<{ id: string; status: string }[]>`
          UPDATE app.gradebooks SET status = 'active' WHERE id = ${a.gradebook}
          RETURNING id, status::text AS status
        `;
        expect(row!.status).toBe("active");
        const [frozen] = await tx<{ id: string }[]>`
          UPDATE app.gradebooks SET class_id = ${a.classId} WHERE id = ${a.gradebook}
          RETURNING id
        `;
        expect(frozen).toBeDefined();
      });
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "enforces grade_submission state transitions: valid transitions succeed, invalid are rejected",
  async () => {
    const database = await migratedDatabase();
    try {
      const schoolA = await createSchool(database, "submission-transition-a");
      const a = await createFixture(database, schoolA, "TRN-A");

      await expectDenied(
        database,
        `INSERT INTO app.grade_submissions
          (school_id, gradebook_id, student_id, status)
         VALUES ('${schoolA}','${a.gradebook}','${a.student}','submitted')`,
        schoolA,
      );

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;

        await tx`
          UPDATE app.grade_submissions
          SET status = 'submitted', submitted_by_user_id = ${a.staffUser}
          WHERE id = ${a.submission}
        `;
        let [row] = await tx<{ status: string }[]>`
          SELECT status::text AS status FROM app.grade_submissions WHERE id = ${a.submission}
        `;
        expect(row!.status).toBe("submitted");

        await tx`
          UPDATE app.grade_submissions
          SET status = 'approved', decided_by_user_id = ${a.staffUser}
          WHERE id = ${a.submission}
        `;
        [row] = await tx<{ status: string }[]>`
          SELECT status::text AS status FROM app.grade_submissions WHERE id = ${a.submission}
        `;
        expect(row!.status).toBe("approved");

        await tx`UPDATE app.grade_submissions SET status = 'published' WHERE id = ${a.submission}`;
        [row] = await tx<{ status: string }[]>`
          SELECT status::text AS status FROM app.grade_submissions WHERE id = ${a.submission}
        `;
        expect(row!.status).toBe("published");
      });

      await expectDenied(
        database,
        `UPDATE app.grade_submissions SET status = 'draft' WHERE id = '${a.submission}'`,
        schoolA,
      );

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;

        await tx`
          UPDATE app.grade_submissions
          SET status = 'submitted', submitted_by_user_id = ${a.staffUser}
          WHERE id = ${a.secondSubmission}
        `;
        await tx`
          UPDATE app.grade_submissions
          SET status = 'rejected', decided_by_user_id = ${a.staffUser}
          WHERE id = ${a.secondSubmission}
        `;
        let [row] = await tx<{ status: string }[]>`
          SELECT status::text AS status FROM app.grade_submissions
          WHERE id = ${a.secondSubmission}
        `;
        expect(row!.status).toBe("rejected");

        await tx`UPDATE app.grade_submissions SET status = 'draft' WHERE id = ${a.secondSubmission}`;
        [row] = await tx<{ status: string }[]>`
          SELECT status::text AS status FROM app.grade_submissions
          WHERE id = ${a.secondSubmission}
        `;
        expect(row!.status).toBe("draft");
        const [audit] = await tx<{ submitted_at: string | null }[]>`
          SELECT submitted_at::text FROM app.grade_submissions WHERE id = ${a.secondSubmission}
        `;
        expect(audit!.submitted_at).toBeNull();
      });

      await expectDenied(
        database,
        `UPDATE app.grade_submissions
         SET submitted_at = '2026-01-01' WHERE id = '${a.submission}'`,
        schoolA,
      );
      await expectDenied(
        database,
        `UPDATE app.grade_submissions
         SET status = 'invented' WHERE id = '${a.submission}'`,
        schoolA,
      );
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "enforces grade constraints: score bounds, max_score, weight, label, and tenant-safe relationships",
  async () => {
    const database = await migratedDatabase();
    try {
      const schoolA = await createSchool(database, "grade-integrity-a");
      const schoolB = await createSchool(database, "grade-integrity-b");
      const a = await createFixture(database, schoolA, "GRD-A");
      const b = await createFixture(database, schoolB, "GRD-B");

      await expectDenied(
        database,
        `INSERT INTO app.grades
          (school_id, grade_submission_id, score, max_score, weight, label)
         VALUES ('${schoolA}','${b.submission}',80,100,1,'Cross school')`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.grades
          (school_id, grade_submission_id, score, max_score, weight, label)
         VALUES ('${schoolA}','${a.submission}',-1,100,1,'Negative')`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.grades
          (school_id, grade_submission_id, score, max_score, weight, label)
         VALUES ('${schoolA}','${a.submission}',101,100,1,'Over max')`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.grades
          (school_id, grade_submission_id, score, max_score, weight, label)
         VALUES ('${schoolA}','${a.submission}',80,0,1,'Zero max')`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.grades
          (school_id, grade_submission_id, score, max_score, weight, label)
         VALUES ('${schoolA}','${a.submission}',80,100,-1,'Negative weight')`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.grades
          (school_id, grade_submission_id, score, max_score, weight, label)
         VALUES ('${schoolA}','${a.submission}',80,100,1,'')`,
        schoolA,
      );

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        const [grade] = await tx<{ id: string }[]>`
          INSERT INTO app.grades
            (school_id, grade_submission_id, score, max_score, weight, label)
          VALUES (${schoolA}, ${a.submission}, 85.5, 100, 2, 'Midterm') RETURNING id
        `;
        const [ungraded] = await tx<{ id: string }[]>`
          INSERT INTO app.grades
            (school_id, grade_submission_id, max_score, weight, label)
          VALUES (${schoolA}, ${a.submission}, 50, 1, 'Participation') RETURNING id
        `;
        const [row] = await tx<{ score: string | null; maxScore: string; label: string }[]>`
          SELECT score::text AS "score", max_score::text AS "maxScore", label
          FROM app.grades WHERE id = ${grade!.id}
        `;
        expect(row!.score).toBe("85.50");
        expect(row!.maxScore).toBe("100.00");
        expect(row!.label).toBe("Midterm");
        const [ungradedRow] = await tx<{ score: string | null }[]>`
          SELECT score::text AS "score" FROM app.grades WHERE id = ${ungraded!.id}
        `;
        expect(ungradedRow!.score).toBeNull();
      });
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "forces fail-closed tenant isolation on every grades workflow table",
  async () => {
    const database = await migratedDatabase();
    try {
      const schoolA = await createSchool(database, "grades-rls-a");
      const schoolB = await createSchool(database, "grades-rls-b");
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
      await expectDenied(database, "SELECT app.apply_tenant_isolation('app', 'gradebooks')");

      for (const [table, id] of [
        ["gradebooks", a.gradebook],
        ["grade_submissions", a.submission],
      ]) {
        await expectDenied(
          database,
          `UPDATE app.${table} SET school_id='${schoolB}' WHERE id='${id}'`,
          schoolA,
        );
      }
      const [gradeId] = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        return tx<{ id: string }[]>`
          INSERT INTO app.grades
            (school_id, grade_submission_id, max_score, weight, label)
          VALUES (${schoolA}, ${a.submission}, 100, 1, 'RLS test') RETURNING id
        `;
      });
      await expectDenied(
        database,
        `UPDATE app.grades SET school_id='${schoolB}' WHERE id='${gradeId!.id}'`,
        schoolA,
      );

      await expectDenied(
        database,
        `INSERT INTO app.grade_submissions
          (school_id, gradebook_id, student_id)
         VALUES ('${schoolB}','${b.gradebook}','${b.student}')`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.grades
          (school_id, grade_submission_id, max_score, weight, label)
         VALUES ('${schoolB}','${b.submission}',100,1,'Blocked')`,
        schoolA,
      );
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "derives grades visibility from submission state: no stored flag, only published grants access",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "grades-visibility");
      const fixture = await createFixture(database, school, "VIS");

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;

        await tx`
          INSERT INTO app.grades
            (school_id, grade_submission_id, score, max_score, weight, label)
          VALUES (${school}, ${fixture.submission}, 90, 100, 1, 'Visible test')
        `;

        let [vis] = await tx<{ visible: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM app.grade_submissions
            WHERE id = ${fixture.submission} AND status = 'published'
          ) AS visible
        `;
        expect(vis!.visible).toBe(false);

        await tx`
          UPDATE app.grade_submissions
          SET status = 'submitted', submitted_by_user_id = ${fixture.staffUser}
          WHERE id = ${fixture.submission}
        `;
        [vis] = await tx<{ visible: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM app.grade_submissions
            WHERE id = ${fixture.submission} AND status = 'published'
          ) AS visible
        `;
        expect(vis!.visible).toBe(false);

        await tx`
          UPDATE app.grade_submissions
          SET status = 'approved', decided_by_user_id = ${fixture.staffUser}
          WHERE id = ${fixture.submission}
        `;
        [vis] = await tx<{ visible: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM app.grade_submissions
            WHERE id = ${fixture.submission} AND status = 'published'
          ) AS visible
        `;
        expect(vis!.visible).toBe(false);

        await tx`UPDATE app.grade_submissions SET status = 'published' WHERE id = ${fixture.submission}`;
        [vis] = await tx<{ visible: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM app.grade_submissions
            WHERE id = ${fixture.submission} AND status = 'published'
          ) AS visible
        `;
        expect(vis!.visible).toBe(true);

        const columns = await database.sql<{ columnName: string }[]>`
          SELECT column_name AS "columnName"
          FROM information_schema.columns
          WHERE table_schema = 'app' AND table_name = 'grades'
            AND column_name IN ('visible', 'is_visible', 'visibility')
        `;
        expect(columns).toHaveLength(0);
      });
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
      const school = await createSchool(database, "grades-indexes");
      const fixture = await createFixture(database, school, "IDX");

      const forbiddenColumns = await database.sql<{ tableName: string; columnName: string }[]>`
        SELECT table_name AS "tableName", column_name AS "columnName"
        FROM information_schema.columns
        WHERE table_schema='app' AND table_name = ANY(${TABLES as unknown as string[]})
          AND (
            data_type IN ('ARRAY', 'json', 'jsonb', 'bytea')
            OR column_name = ANY(${[
              "student_ids",
              "grade_ids",
              "submission_ids",
              "average_score",
              "weighted_score",
              "student_name",
              "class_name",
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
          UPDATE app.grade_submissions
          SET status = 'submitted', submitted_by_user_id = ${fixture.staffUser},
            submitted_at = '2026-09-01'
          WHERE id = ${fixture.submission}
        `;
        await tx`
          INSERT INTO app.grades (school_id, grade_submission_id, score, max_score, weight, label)
          SELECT ${school}, ${fixture.submission}, g, 100, 1, 'Grade ' || g
          FROM generate_series(1, 40) AS g
        `;
      });
      await database.sql.unsafe("VACUUM ANALYZE app.grades");

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        await tx.unsafe("SET LOCAL enable_seqscan = off");
        await tx.unsafe("SET LOCAL enable_bitmapscan = off");
        await tx.unsafe("SET LOCAL enable_sort = off");
        const queries = [
          [
            ["idx_gradebooks_school_class_id"],
            `SELECT school_id, class_id, id FROM app.gradebooks
             WHERE school_id='${school}' AND class_id='${fixture.classId}'`,
          ],
          [
            ["idx_grade_submissions_school_gradebook_id"],
            `SELECT school_id, gradebook_id, id FROM app.grade_submissions
             WHERE school_id='${school}' AND gradebook_id='${fixture.gradebook}'`,
          ],
          [
            ["idx_grade_submissions_school_student_id"],
            `SELECT school_id, student_id, id FROM app.grade_submissions
             WHERE school_id='${school}' AND student_id='${fixture.student}'`,
          ],
          [
            ["idx_grade_submissions_school_status_submitted_at"],
            `SELECT school_id, status, submitted_at, id FROM app.grade_submissions
             WHERE school_id='${school}' AND status='submitted'
             AND submitted_at >= '2026-01-01' ORDER BY submitted_at, id`,
          ],
          [
            ["idx_grades_school_grade_submission_id"],
            `SELECT school_id, grade_submission_id, id FROM app.grades
             WHERE school_id='${school}' AND grade_submission_id='${fixture.submission}'`,
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
