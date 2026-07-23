import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");
const ACADEMIC_TABLES = [
  "academic_years",
  "terms",
  "subjects",
  "courses",
  "rooms",
  "classes",
  "enrollments",
] as const;

type Database = Awaited<ReturnType<typeof testDatabase>>;
type Role = "studafy_admin" | "studafy_app";

interface TenantFixture {
  school: string;
  year: string;
  term: string;
  subject: string;
  course: string;
  room: string;
  teacher: string;
  student: string;
  classId: string;
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

async function createSchools(database: Database): Promise<{ a: string; b: string }> {
  const [refs] = await database.sql<{ country: string; currency: string }[]>`
    SELECT
      (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
      (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
  `;
  return asRole(database, "studafy_admin", async (tx) => {
    const rows = await tx<{ id: string; slug: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES
        ('academic-a', 'Academic A', 'academic-a@admin.local', 'academic-a@admin.local', ${refs!.country}, ${refs!.currency}),
        ('academic-b', 'Academic B', 'academic-b@admin.local', 'academic-b@admin.local', ${refs!.country}, ${refs!.currency})
      RETURNING id, slug
    `;
    return {
      a: rows.find((row) => row.slug === "academic-a")!.id,
      b: rows.find((row) => row.slug === "academic-b")!.id,
    };
  });
}

async function createTenantFixture(
  database: Database,
  school: string,
  suffix: string,
): Promise<TenantFixture> {
  return asRole(database, "studafy_app", async (tx) => {
    await tx`SELECT set_config('app.school_id', ${school}, true)`;
    const studentEmail = `student-${suffix.toLowerCase()}@example.test`;
    const teacherEmail = `teacher-${suffix.toLowerCase()}@example.test`;
    const [studentUser] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${school}, ${studentEmail}, ${studentEmail}, 'active') RETURNING id
    `;
    const [teacherUser] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${school}, ${teacherEmail}, ${teacherEmail}, 'active') RETURNING id
    `;
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
      VALUES (${school}, ${studentUser!.id}, ${`ADM-${suffix}`}, 'Test', 'Student') RETURNING id
    `;
    const [teacher] = await tx<{ id: string }[]>`
      INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
      VALUES (${school}, ${teacherUser!.id}, ${`EMP-${suffix}`}, 'active') RETURNING id
    `;
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years
        (school_id, code, name, starts_on, ends_on, status)
      VALUES (${school}, ${`AY-${suffix}`}, ${`Academic Year ${suffix}`},
        '2026-08-01', '2027-06-30', 'active') RETURNING id
    `;
    const [term] = await tx<{ id: string }[]>`
      INSERT INTO app.terms
        (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
      VALUES (${school}, ${year!.id}, ${`T-${suffix}`}, 'First Term', 1,
        '2026-08-15', '2026-12-20', 'active') RETURNING id
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
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building, floor)
      VALUES (${school}, ${`ROOM-${suffix}`}, 'Room One', 'physical', 30, 'Main', '1')
      RETURNING id
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
      VALUES (${school}, ${classRow!.id}, ${student!.id})
    `;
    return {
      school,
      year: year!.id,
      term: term!.id,
      subject: subject!.id,
      course: course!.id,
      room: room!.id,
      teacher: teacher!.id,
      student: student!.id,
      classId: classRow!.id,
    };
  });
}

integrationTest(
  "installs the academic schema, ownership, grants, keys, triggers, and forced policies",
  async () => {
    const database = await migratedDatabase();
    try {
      const enums = await database.sql<{ type: string; values: string[] }[]>`
        SELECT t.typname AS type, array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
        FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
        JOIN pg_enum e ON e.enumtypid=t.oid
        WHERE n.nspname='app' AND t.typname = ANY(ARRAY[
          'academic_period_status','catalog_status','class_status','enrollment_status','room_type'
        ]) GROUP BY t.typname ORDER BY t.typname
      `;
      expect(enums.map(({ type, values }) => ({ type, values }))).toEqual([
        { type: "academic_period_status", values: ["planned", "active", "closed", "archived"] },
        { type: "catalog_status", values: ["draft", "active", "inactive", "archived"] },
        { type: "class_status", values: ["planned", "active", "completed", "cancelled"] },
        {
          type: "enrollment_status",
          values: ["active", "waitlisted", "withdrawn", "completed", "cancelled"],
        },
        { type: "room_type", values: ["physical", "virtual"] },
      ]);

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
          has_table_privilege('studafy_app',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS "appCrud",
          has_table_privilege('public',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS "publicAccess"
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='app' AND c.relname = ANY(${ACADEMIC_TABLES as unknown as string[]})
        ORDER BY c.relname
      `;
      expect(tables.map((row) => row.name)).toEqual([...ACADEMIC_TABLES].sort());
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
        { tableName: string; name: string; command: string; using: string; check: string }[]
      >`
        SELECT c.relname AS "tableName", p.polname AS name, p.polcmd AS command,
          pg_get_expr(p.polqual,p.polrelid) AS using,
          pg_get_expr(p.polwithcheck,p.polrelid) AS check
        FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
        WHERE c.relnamespace='app'::regnamespace
          AND c.relname = ANY(${ACADEMIC_TABLES as unknown as string[]}) ORDER BY c.relname
      `;
      expect(policies).toHaveLength(7);
      for (const policy of policies) {
        expect(policy.name).toBe("tenant_isolation");
        expect(policy.command).toBe("*");
        expect(policy.using).toContain("current_setting('app.school_id'::text)");
        expect(policy.check).toContain("current_setting('app.school_id'::text)");
      }

      const constraints = await database.sql<{ name: string }[]>`
        SELECT conname AS name FROM pg_constraint WHERE connamespace='app'::regnamespace
          AND conname = ANY(ARRAY[
            'uq_academic_years_id_school','uq_academic_years_school_code',
            'uq_terms_id_academic_year_school','uq_terms_school_academic_year_code',
            'uq_terms_school_academic_year_sequence','uq_subjects_id_school',
            'uq_subjects_school_code','uq_courses_id_school','uq_courses_school_code',
            'uq_rooms_id_school','uq_rooms_school_code','uq_classes_id_school',
            'uq_classes_school_code','pk_enrollments'
          ])
      `;
      expect(constraints).toHaveLength(14);

      const foreignKeys = await database.sql<{ name: string; definition: string }[]>`
        SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE connamespace='app'::regnamespace AND contype='f'
          AND conrelid::regclass::text = ANY(${ACADEMIC_TABLES.map((name) => `app.${name}`) as unknown as string[]})
      `;
      expect(foreignKeys).toHaveLength(16);
      expect(
        foreignKeys.every((fk) => fk.definition.includes("ON UPDATE RESTRICT ON DELETE RESTRICT")),
      ).toBe(true);
      expect(foreignKeys.find((fk) => fk.name === "fk_classes_term")!.definition).toContain(
        "FOREIGN KEY (term_id, academic_year_id, school_id)",
      );

      const triggerFunctions = await database.sql<
        { name: string; owner: string; appExecute: boolean }[]
      >`
        SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner,
          has_function_privilege('studafy_app',p.oid,'EXECUTE') AS "appExecute"
        FROM pg_proc p WHERE p.pronamespace='app'::regnamespace
          AND p.proname IN ('enforce_term_within_academic_year','prevent_academic_year_term_date_violation')
        ORDER BY p.proname
      `;
      expect(
        triggerFunctions.map(({ name, owner, appExecute }) => ({ name, owner, appExecute })),
      ).toEqual([
        { name: "enforce_term_within_academic_year", owner: "studafy_admin", appExecute: false },
        {
          name: "prevent_academic_year_term_date_violation",
          owner: "studafy_admin",
          appExecute: false,
        },
      ]);
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "enforces academic, room, enrollment, and cross-school integrity",
  async () => {
    const database = await migratedDatabase();
    try {
      const schools = await createSchools(database);
      const a = await createTenantFixture(database, schools.a, "A");
      const b = await createTenantFixture(database, schools.b, "B");

      for (const statement of [
        `INSERT INTO app.academic_years (school_id,code,name,starts_on,ends_on,status)
       VALUES ('${a.school}','AY-SECOND','Second','2026-09-01','2027-05-31','active')`,
        `INSERT INTO app.academic_years (school_id,code,name,starts_on,ends_on)
       VALUES ('${a.school}','AY-BAD','Bad','2027-01-01','2027-01-01')`,
        `INSERT INTO app.terms
       (school_id,academic_year_id,code,name,sequence_number,starts_on,ends_on)
       VALUES ('${a.school}','${a.year}','OUT','Outside',2,'2026-07-01','2026-08-10')`,
        `UPDATE app.academic_years SET starts_on='2026-09-01' WHERE id='${a.year}'`,
        `INSERT INTO app.rooms (school_id,code,name,room_type,building,virtual_url)
       VALUES ('${a.school}','BAD-V','Bad virtual','virtual','Main','http://example.test')`,
        `UPDATE app.enrollments SET status='withdrawn' WHERE class_id='${a.classId}'`,
        `UPDATE app.enrollments SET status='withdrawn', withdrawn_at='2020-01-01'
       WHERE class_id='${a.classId}'`,
        `INSERT INTO app.classes
       (school_id,course_id,academic_year_id,term_id,lead_teacher_id,room_id,code)
       VALUES ('${a.school}','${a.course}','${a.year}','${a.term}','${a.teacher}','${a.room}','CLASS-A')`,
      ])
        await expectDenied(database, statement, a.school);

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${a.school}, true)`;
        await tx`INSERT INTO app.rooms (school_id,code,name,room_type,virtual_url)
        VALUES (${a.school},'VIRTUAL','Virtual Room','virtual','https://meet.example.test/room')`;
      });

      const crossTenantStatements = [
        `INSERT INTO app.terms (school_id,academic_year_id,code,name,sequence_number,starts_on,ends_on)
       VALUES ('${a.school}','${b.year}','CROSS','Cross',2,'2026-09-01','2026-10-01')`,
        `INSERT INTO app.courses (school_id,subject_id,code,name)
       VALUES ('${a.school}','${b.subject}','CROSS','Cross')`,
        `INSERT INTO app.classes
       (school_id,course_id,academic_year_id,term_id,lead_teacher_id,room_id,code)
       VALUES ('${a.school}','${b.course}','${a.year}','${a.term}','${a.teacher}','${a.room}','CROSS-C')`,
        `INSERT INTO app.classes
       (school_id,course_id,academic_year_id,term_id,lead_teacher_id,room_id,code)
       VALUES ('${a.school}','${a.course}','${a.year}','${b.term}','${a.teacher}','${a.room}','CROSS-T')`,
        `INSERT INTO app.classes
       (school_id,course_id,academic_year_id,term_id,lead_teacher_id,room_id,code)
       VALUES ('${a.school}','${a.course}','${a.year}','${a.term}','${b.teacher}','${a.room}','CROSS-L')`,
        `INSERT INTO app.classes
       (school_id,course_id,academic_year_id,term_id,lead_teacher_id,room_id,code)
       VALUES ('${a.school}','${a.course}','${a.year}','${a.term}','${a.teacher}','${b.room}','CROSS-R')`,
        `INSERT INTO app.enrollments (school_id,class_id,student_id)
       VALUES ('${a.school}','${a.classId}','${b.student}')`,
        `INSERT INTO app.enrollments (school_id,class_id,student_id)
       VALUES ('${a.school}','${b.classId}','${a.student}')`,
      ];
      for (const statement of crossTenantStatements)
        await expectDenied(database, statement, a.school, "studafy_admin");
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "fails closed and isolates every academic table",
  async () => {
    const database = await migratedDatabase();
    try {
      const schools = await createSchools(database);
      const a = await createTenantFixture(database, schools.a, "A");
      await createTenantFixture(database, schools.b, "B");

      for (const table of ACADEMIC_TABLES) {
        await expectDenied(database, `SELECT * FROM app.${table}`);
        await expectDenied(database, `SELECT * FROM app.${table}`, "not-a-uuid");
        const counts = await asRole(database, "studafy_app", async (tx) => {
          await tx`SELECT set_config('app.school_id', ${a.school}, true)`;
          return tx.unsafe(`SELECT count(*)::integer AS count FROM app.${table}`);
        });
        expect(counts[0]!.count).toBe(1);
        const hidden = await asRole(database, "studafy_app", async (tx) => {
          await tx`SELECT set_config('app.school_id', ${schools.b}, true)`;
          const update = await tx.unsafe(
            `UPDATE app.${table} SET updated_at=updated_at WHERE school_id='${a.school}'`,
          );
          const deletion = await tx.unsafe(
            `DELETE FROM app.${table} WHERE school_id='${a.school}'`,
          );
          return [update.count, deletion.count];
        });
        expect(hidden).toEqual([0, 0]);
      }

      const tenantMutationTargets = [
        ["academic_years", "id", a.year],
        ["terms", "id", a.term],
        ["subjects", "id", a.subject],
        ["courses", "id", a.course],
        ["rooms", "id", a.room],
        ["classes", "id", a.classId],
        ["enrollments", "class_id", a.classId],
      ];
      for (const [table, key, id] of tenantMutationTargets)
        await expectDenied(
          database,
          `UPDATE app.${table} SET school_id='${schools.b}' WHERE ${key}='${id}'`,
          a.school,
        );

      await expectDenied(database, "SELECT * FROM app.academic_years", undefined, "studafy_admin");
      for (const statement of [
        "ALTER TABLE app.academic_years DISABLE ROW LEVEL SECURITY",
        "DROP POLICY tenant_isolation ON app.terms",
        "CREATE INDEX forbidden_academic_index ON app.subjects (school_id)",
        "SELECT app.apply_tenant_isolation('app','subjects')",
      ])
        await expectDenied(database, statement, a.school);
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "keeps deliberate normalized indexes and uses tenant-leading query plans",
  async () => {
    const database = await migratedDatabase();
    try {
      const expectedNonConstraintIndexes = [
        "idx_classes_school_academic_year_id",
        "idx_classes_school_course_id",
        "idx_classes_school_lead_teacher_id",
        "idx_classes_school_room_id",
        "idx_classes_school_term_id",
        "idx_courses_school_subject_id",
        "idx_enrollments_school_student_class",
        "uq_academic_years_one_active_per_school",
      ];
      const indexes = await database.sql<{ name: string }[]>`
      SELECT i.relname AS name FROM pg_index x
      JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid
      LEFT JOIN pg_constraint c ON c.conindid=x.indexrelid
      WHERE t.relnamespace='app'::regnamespace
        AND t.relname = ANY(${ACADEMIC_TABLES as unknown as string[]}) AND c.oid IS NULL
      ORDER BY i.relname
    `;
      expect(indexes.map((row) => row.name)).toEqual(expectedNonConstraintIndexes);

      const duplicateShapes = await database.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM (
        SELECT indrelid,indkey,indclass,indcollation,indoption,indexprs,indpred
        FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
        WHERE t.relnamespace='app'::regnamespace
          AND t.relname = ANY(${ACADEMIC_TABLES as unknown as string[]})
        GROUP BY indrelid,indkey,indclass,indcollation,indoption,indexprs,indpred
        HAVING count(*) > 1
      ) duplicate_indexes
    `;
      expect(duplicateShapes[0]!.count).toBe("0");

      const schools = await createSchools(database);
      const fixture = await createTenantFixture(database, schools.a, "PLAN");
      const plans = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schools.a}, true)`;
        await tx`SET LOCAL enable_seqscan=off`;
        const statements = [
          `SELECT * FROM app.academic_years WHERE school_id='${schools.a}' AND status='active'`,
          `SELECT * FROM app.terms WHERE school_id='${schools.a}' AND academic_year_id='${fixture.year}' ORDER BY sequence_number`,
          `SELECT * FROM app.courses WHERE school_id='${schools.a}' AND subject_id='${fixture.subject}'`,
          `SELECT * FROM app.classes WHERE school_id='${schools.a}' AND term_id='${fixture.term}'`,
          `SELECT * FROM app.classes WHERE school_id='${schools.a}' AND lead_teacher_id='${fixture.teacher}'`,
          `SELECT * FROM app.enrollments WHERE school_id='${schools.a}' AND class_id='${fixture.classId}'`,
          `SELECT * FROM app.enrollments WHERE school_id='${schools.a}' AND student_id='${fixture.student}'`,
          `SELECT * FROM app.classes WHERE school_id='${schools.a}' AND code > '' ORDER BY code LIMIT 20`,
        ];
        const serialized: string[] = [];
        for (const statement of statements)
          serialized.push(JSON.stringify(await tx.unsafe(`EXPLAIN (FORMAT JSON) ${statement}`)));
        return serialized;
      });
      expect(plans[0]).toContain("uq_academic_years_one_active_per_school");
      expect(plans[1]).toContain("uq_terms_school_academic_year_sequence");
      expect(plans[2]).toContain("idx_courses_school_subject_id");
      expect(plans[3]).toContain("idx_classes_school_term_id");
      expect(plans[4]).toContain("idx_classes_school_lead_teacher_id");
      expect(plans[5]).toContain("pk_enrollments");
      expect(plans[6]).toContain("idx_enrollments_school_student_class");
      expect(plans[7]).toContain("uq_classes_school_code");

      const forbiddenColumns = await database.sql<{ name: string }[]>`
      SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema='app' AND table_name = ANY(${ACADEMIC_TABLES as unknown as string[]})
        AND (data_type IN ('ARRAY','json','jsonb') OR column_name ~
          '(student_ids|class_ids|term_[0-9]|subject_name|course_name|school_name|enrollment_count)')
    `;
      expect(forbiddenColumns).toHaveLength(0);
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);
