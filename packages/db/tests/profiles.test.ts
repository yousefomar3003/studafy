import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");
const PROFILE_TABLES = ["students", "teachers", "parent_child_links"] as const;

type Database = Awaited<ReturnType<typeof testDatabase>>;
type Role = "studafy_admin" | "studafy_app";

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

async function createSchools(
  database: Database,
): Promise<{ a: string; b: string; country: string }> {
  const [refs] = await database.sql<{ country: string; currency: string }[]>`
    SELECT
      (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
      (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
  `;
  return asRole(database, "studafy_admin", async (tx) => {
    const rows = await tx<{ id: string; slug: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES
        ('profiles-a', 'Profiles A', 'profiles-a@admin.local', 'profiles-a@admin.local', ${refs!.country}, ${refs!.currency}),
        ('profiles-b', 'Profiles B', 'profiles-b@admin.local', 'profiles-b@admin.local', ${refs!.country}, ${refs!.currency})
      RETURNING id, slug
    `;
    return {
      a: rows.find((row) => row.slug === "profiles-a")!.id,
      b: rows.find((row) => row.slug === "profiles-b")!.id,
      country: refs!.country,
    };
  });
}

async function createUser(database: Database, school: string, localPart: string): Promise<string> {
  return asRole(database, "studafy_app", async (tx) => {
    await tx`SELECT set_config('app.school_id', ${school}, true)`;
    const email = `${localPart}@example.test`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email)
      VALUES (${school}, ${email}, ${email}) RETURNING id
    `;
    return row!.id;
  });
}

integrationTest(
  "installs the exact profile schema, enums, ownership, grants, and forced policies",
  async () => {
    const database = await migratedDatabase();
    try {
      const enums = await database.sql<{ type: string; values: string[] }[]>`
      SELECT t.typname AS type, array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = 'app'
        AND t.typname IN ('student_status', 'teacher_employment_status', 'parent_relationship')
      GROUP BY t.typname ORDER BY t.typname
    `;
      expect(enums.map(({ type, values }) => ({ type, values }))).toEqual([
        {
          type: "parent_relationship",
          values: [
            "mother",
            "father",
            "guardian",
            "step_parent",
            "grandparent",
            "sibling",
            "other",
          ],
        },
        {
          type: "student_status",
          values: ["applicant", "enrolled", "suspended", "graduated", "withdrawn", "archived"],
        },
        {
          type: "teacher_employment_status",
          values: ["pending", "active", "on_leave", "suspended", "terminated", "archived"],
        },
      ]);

      const tables = await database.sql<
        {
          name: string;
          owner: string;
          rls: boolean;
          forced: boolean;
          app_crud: boolean;
          public_access: boolean;
        }[]
      >`
      SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
        c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
        has_table_privilege('studafy_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS app_crud,
        has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS public_access
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relname = ANY(${PROFILE_TABLES as unknown as string[]})
      ORDER BY c.relname
    `;
      expect(tables.map((row) => row.name)).toEqual([...PROFILE_TABLES].sort());
      expect(
        tables.every(
          (row) =>
            row.owner === "studafy_admin" &&
            row.rls &&
            row.forced &&
            row.app_crud &&
            !row.public_access,
        ),
      ).toBe(true);

      const policies = await database.sql<
        {
          table_name: string;
          name: string;
          permissive: boolean;
          command: string;
          roles: number[];
          using: string;
          check: string;
        }[]
      >`
      SELECT c.relname AS table_name, p.polname AS name, p.polpermissive AS permissive,
        p.polcmd AS command, p.polroles::integer[] AS roles,
        pg_get_expr(p.polqual, p.polrelid) AS using,
        pg_get_expr(p.polwithcheck, p.polrelid) AS check
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relname = ANY(${PROFILE_TABLES as unknown as string[]})
      ORDER BY c.relname
    `;
      // Every profile table carries the permissive tenant_isolation policy. ST-085 additionally
      // layers the restrictive role_scope_visibility SELECT policy onto app.students.
      const tenantPolicies = policies.filter((policy) => policy.name === "tenant_isolation");
      const scopePolicies = policies.filter((policy) => policy.name === "role_scope_visibility");
      expect(tenantPolicies).toHaveLength(3);
      for (const policy of tenantPolicies) {
        expect(policy.permissive).toBe(true);
        expect(policy.command).toBe("*");
        expect(policy.roles).toEqual([0]);
        expect(policy.using).toContain(
          "school_id = (current_setting('app.school_id'::text))::uuid",
        );
        expect(policy.check).toContain(
          "school_id = (current_setting('app.school_id'::text))::uuid",
        );
      }
      expect(scopePolicies.map((policy) => policy.table_name)).toEqual(["students"]);
      for (const policy of scopePolicies) {
        expect(policy.permissive).toBe(false);
        expect(policy.command).toBe("r");
      }

      const keys = await database.sql<{ name: string }[]>`
      SELECT conname AS name FROM pg_constraint
      WHERE connamespace = 'app'::regnamespace AND conname = ANY(ARRAY[
        'uq_students_id_school', 'uq_students_school_user',
        'uq_students_school_normalized_admission_number', 'uq_teachers_id_school',
        'uq_teachers_school_user', 'uq_teachers_school_normalized_employee_number',
        'pk_parent_child_links'
      ]) ORDER BY conname
    `;
      expect(keys).toHaveLength(7);

      const foreignKeys = await database.sql<{ name: string; definition: string }[]>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE connamespace = 'app'::regnamespace
        AND conname = ANY(ARRAY['fk_students_user', 'fk_teachers_user',
          'fk_parent_child_links_parent_user', 'fk_parent_child_links_student'])
      ORDER BY conname
    `;
      expect(foreignKeys).toHaveLength(4);
      expect(
        foreignKeys.every((fk) => fk.definition.includes("ON UPDATE RESTRICT ON DELETE RESTRICT")),
      ).toBe(true);
      expect(foreignKeys.find((fk) => fk.name === "fk_students_user")!.definition).toContain(
        "(user_id, school_id) REFERENCES app.users(id, school_id)",
      );
      expect(
        foreignKeys.find((fk) => fk.name === "fk_parent_child_links_student")!.definition,
      ).toContain("(student_id, school_id) REFERENCES app.students(id, school_id)");
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "enforces normalized identifiers, lifecycle checks, and composite tenant links",
  async () => {
    const database = await migratedDatabase();
    try {
      const { a, b, country } = await createSchools(database);
      const [studentAUser, studentBUser, teacherAUser, teacherBUser, parentA, foreignParent] =
        await Promise.all([
          createUser(database, a, "student-a"),
          createUser(database, b, "student-b"),
          createUser(database, a, "teacher-a"),
          createUser(database, b, "teacher-b"),
          createUser(database, a, "parent-a"),
          createUser(database, b, "parent-b"),
        ]);

      // ST-085: app.students carries a restrictive role_scope_visibility SELECT policy, which
      // PostgreSQL also applies to INSERT ... RETURNING. Seed as studafy_admin (still bound by
      // tenant_isolation, exempt from the TO studafy_app scope policy).
      const studentA = await asRole(database, "studafy_admin", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${a}, true)`;
        const [row] = await tx<{ id: string; normalized: string }[]>`
        INSERT INTO app.students
          (school_id, user_id, admission_number, first_name, middle_name, last_name,
           preferred_name, date_of_birth, nationality_country_id, admission_date, status)
        VALUES (${a}, ${studentAUser}, 'Adm-001', 'Ada', 'Marie', 'Lovelace', 'Ada',
          '2012-12-10', ${country}, '2024-09-01', 'enrolled')
        RETURNING id, normalized_admission_number AS normalized
      `;
        expect(row!.normalized).toBe("adm-001");
        return row!.id;
      });

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${b}, true)`;
        await tx`INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
        VALUES (${b}, ${studentBUser}, 'adm-001', 'Grace', 'Hopper')`;
      });
      await expectDenied(
        database,
        `INSERT INTO app.students (school_id,user_id,admission_number,first_name,last_name)
       VALUES ('${a}','${parentA}','ADM-001','Duplicate','Student')`,
        a,
      );
      await expectDenied(
        database,
        `INSERT INTO app.students (school_id,user_id,admission_number,first_name,last_name)
       VALUES ('${a}','${foreignParent}','A-2','Cross','School')`,
        a,
      );
      await expectDenied(
        database,
        `INSERT INTO app.students (school_id,user_id,admission_number,first_name,last_name)
       VALUES ('${a}','${parentA}',' A-2 ','Trim','Failure')`,
        a,
      );

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${a}, true)`;
        const [teacher] = await tx<{ normalized: string }[]>`
        INSERT INTO app.teachers (school_id,user_id,employee_number,employment_status,hire_date)
        VALUES (${a},${teacherAUser},'Teach-X','active','2024-01-01')
        RETURNING normalized_employee_number AS normalized
      `;
        expect(teacher!.normalized).toBe("teach-x");
        await tx`INSERT INTO app.parent_child_links (school_id,parent_user_id,student_id,relationship)
        VALUES (${a},${parentA},${studentA},'guardian')`;
      });
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${b}, true)`;
        await tx`INSERT INTO app.teachers (school_id,user_id,employee_number)
        VALUES (${b},${teacherBUser},'teach-x')`;
      });
      await expectDenied(
        database,
        `INSERT INTO app.teachers (school_id,user_id,employee_number)
       VALUES ('${a}','${parentA}','TEACH-X')`,
        a,
      );
      await expectDenied(
        database,
        `INSERT INTO app.teachers (school_id,user_id,employee_number,hire_date,termination_date)
       VALUES ('${a}','${parentA}','T-2','2025-01-01','2024-01-01')`,
        a,
      );
      await expectDenied(
        database,
        `INSERT INTO app.teachers (school_id,user_id,employee_number,termination_date)
       VALUES ('${a}','${parentA}','T-3','2025-01-01')`,
        a,
      );
      await expectDenied(
        database,
        `INSERT INTO app.parent_child_links (school_id,parent_user_id,student_id,relationship)
       VALUES ('${a}','${parentA}','${studentA}','guardian')`,
        a,
      );
      await expectDenied(
        database,
        `INSERT INTO app.parent_child_links (school_id,parent_user_id,student_id,relationship)
       VALUES ('${a}','${foreignParent}','${studentA}','guardian')`,
        a,
      );
      await expectDenied(
        database,
        `INSERT INTO app.parent_child_links (school_id,parent_user_id,student_id,relationship)
       VALUES ('${a}','${parentA}','${studentA}','custodian')`,
        a,
      );
      await expectDenied(
        database,
        `INSERT INTO app.students (school_id,user_id,admission_number,first_name,last_name,status)
       VALUES ('${a}','${parentA}','A-STATUS','Bad','Status','inactive')`,
        a,
      );
      await expectDenied(
        database,
        `INSERT INTO app.teachers (school_id,user_id,employee_number,employment_status)
       VALUES ('${a}','${parentA}','T-STATUS','retired')`,
        a,
      );
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "fails closed and isolates CRUD independently on every profile table",
  async () => {
    const database = await migratedDatabase();
    try {
      const { a, b } = await createSchools(database);
      const studentUser = await createUser(database, a, "rls-student");
      const teacherUser = await createUser(database, a, "rls-teacher");
      const parentUser = await createUser(database, a, "rls-parent");
      const foreignUser = await createUser(database, b, "rls-foreign");
      let student = "";
      // ST-085: seed the scoped app.students row as studafy_admin (see the studentA fixture above).
      await asRole(database, "studafy_admin", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${a}, true)`;
        const [row] = await tx<{ id: string }[]>`INSERT INTO app.students
        (school_id,user_id,admission_number,first_name,last_name)
        VALUES (${a},${studentUser},'RLS-1','Tenant','Student') RETURNING id`;
        student = row!.id;
        await tx`INSERT INTO app.teachers (school_id,user_id,employee_number)
        VALUES (${a},${teacherUser},'RLS-T')`;
        await tx`INSERT INTO app.parent_child_links (school_id,parent_user_id,student_id,relationship)
        VALUES (${a},${parentUser},${student},'guardian')`;
      });

      for (const table of PROFILE_TABLES) {
        await expectDenied(database, `SELECT * FROM app.${table}`);
        for (const bad of ["", " ", "not-a-uuid", "00000000-0000-0000-0000-00000000000z"])
          await expectDenied(database, `SELECT * FROM app.${table}`, bad);
        const counts = await asRole(database, "studafy_app", async (tx) => {
          await tx`SELECT set_config('app.school_id', ${b}, true)`;
          return tx.unsafe<{ count: string }[]>(`SELECT count(*)::text AS count FROM app.${table}`);
        });
        expect(counts[0]!.count).toBe("0");
      }
      const nonexistent = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true)`;
        return tx<{ count: string }[]>`SELECT count(*)::text AS count FROM app.students`;
      });
      expect(nonexistent[0]!.count).toBe("0");

      await expectDenied(
        database,
        `INSERT INTO app.students (school_id,user_id,admission_number,first_name,last_name)
       VALUES ('${a}','${foreignUser}','X','Cross','Tenant')`,
        b,
      );
      // ST-085: role_scope_visibility (SELECT policy) also gates the rows an UPDATE/DELETE can see.
      // A userless studafy_app would match zero rows here and never reach tenant_isolation's WITH
      // CHECK, so run this cross-school denial as studafy_admin, which sees the row (tenant_isolation
      // only) and is still blocked from moving it to another school.
      await expectDenied(
        database,
        `UPDATE app.students SET school_id='${b}' WHERE id='${student}'`,
        a,
        "studafy_admin",
      );
      await expectDenied(database, `UPDATE app.teachers SET school_id='${b}'`, a);
      await expectDenied(database, `UPDATE app.parent_child_links SET school_id='${b}'`, a);

      const hiddenWrites = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${b}, true)`;
        const updates = await tx.unsafe(
          `UPDATE app.students SET first_name='Hidden' WHERE id='${student}'`,
        );
        const deletes = await tx.unsafe(
          `DELETE FROM app.parent_child_links WHERE student_id='${student}'`,
        );
        return [updates.count, deletes.count];
      });
      expect(hiddenWrites).toEqual([0, 0]);

      // ST-085: these own-tenant writes must see the scoped app.students row to affect it, so run as
      // studafy_admin (exempt from role_scope_visibility, still bound by tenant_isolation).
      const ownWrites = await asRole(database, "studafy_admin", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${a}, true)`;
        const studentUpdate =
          await tx`UPDATE app.students SET preferred_name='Own' WHERE id=${student}`;
        const teacherUpdate = await tx`UPDATE app.teachers SET employment_status='active'`;
        const linkUpdate = await tx`UPDATE app.parent_child_links SET relationship='mother'`;
        const linkDelete = await tx`DELETE FROM app.parent_child_links WHERE student_id=${student}`;
        const teacherDelete = await tx`DELETE FROM app.teachers`;
        const studentDelete = await tx`DELETE FROM app.students WHERE id=${student}`;
        return [
          studentUpdate.count,
          teacherUpdate.count,
          linkUpdate.count,
          linkDelete.count,
          teacherDelete.count,
          studentDelete.count,
        ];
      });
      expect(ownWrites).toEqual([1, 1, 1, 1, 1, 1]);

      // FORCE applies to the owner too; missing owner context cannot read rows.
      await expectDenied(database, "SELECT * FROM app.students", undefined, "studafy_admin");
      for (const statement of [
        "ALTER TABLE app.students DISABLE ROW LEVEL SECURITY",
        "DROP POLICY tenant_isolation ON app.teachers",
        "CREATE INDEX forbidden_profile_index ON app.students (school_id)",
      ])
        await expectDenied(database, statement, a);
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "keeps the deliberate index set and uses school-leading access paths",
  async () => {
    const database = await migratedDatabase();
    try {
      const indexes = await database.sql<
        { table_name: string; name: string; definition: string }[]
      >`
      SELECT tablename AS table_name, indexname AS name, indexdef AS definition
      FROM pg_indexes WHERE schemaname = 'app'
        AND tablename = ANY(${PROFILE_TABLES as unknown as string[]}) ORDER BY indexname
    `;
      const nonConstraint = await database.sql<{ name: string }[]>`
      SELECT i.relname AS name FROM pg_index x
      JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
      LEFT JOIN pg_constraint c ON c.conindid=x.indexrelid
      WHERE n.nspname='app' AND t.relname = ANY(${PROFILE_TABLES as unknown as string[]})
        AND c.oid IS NULL ORDER BY i.relname
    `;
      expect(nonConstraint.map((row) => row.name)).toEqual([
        "idx_parent_child_links_school_student_parent",
        "idx_students_nationality_country_id",
      ]);
      expect(indexes.some((index) => /\(school_id\)$/.test(index.definition))).toBe(false);

      const duplicateShapes = await database.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM (
        SELECT indrelid, indkey, indclass, indcollation, indoption, indexprs, indpred
        FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
        WHERE t.relnamespace='app'::regnamespace
          AND t.relname = ANY(${PROFILE_TABLES as unknown as string[]})
        GROUP BY indrelid, indkey, indclass, indcollation, indoption, indexprs, indpred
        HAVING count(*) > 1
      ) duplicates
    `;
      expect(duplicateShapes[0]!.count).toBe("0");

      const { a } = await createSchools(database);
      const studentUser = await createUser(database, a, "plan-student");
      const teacherUser = await createUser(database, a, "plan-teacher");
      const parentUser = await createUser(database, a, "plan-parent");
      // ST-085: seed the scoped app.students row as studafy_admin (see the studentA fixture above).
      await asRole(database, "studafy_admin", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${a}, true)`;
        const [student] = await tx<{ id: string }[]>`INSERT INTO app.students
        (school_id,user_id,admission_number,first_name,last_name)
        VALUES (${a},${studentUser},'PLAN-S','Plan','Student') RETURNING id`;
        await tx`INSERT INTO app.teachers (school_id,user_id,employee_number)
        VALUES (${a},${teacherUser},'PLAN-T')`;
        await tx`INSERT INTO app.parent_child_links (school_id,parent_user_id,student_id,relationship)
        VALUES (${a},${parentUser},${student!.id},'guardian')`;
      });

      const planNames = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${a}, true)`;
        await tx`SET LOCAL enable_seqscan = off`;
        const statements = [
          `SELECT * FROM app.students WHERE school_id='${a}' AND normalized_admission_number='plan-s'`,
          `SELECT * FROM app.teachers WHERE school_id='${a}' AND normalized_employee_number='plan-t'`,
          `SELECT * FROM app.parent_child_links WHERE school_id='${a}' AND parent_user_id='${parentUser}'`,
          `SELECT * FROM app.parent_child_links WHERE school_id='${a}' AND student_id=(SELECT id FROM app.students WHERE school_id='${a}' LIMIT 1)`,
          `SELECT * FROM app.students WHERE school_id='${a}'`,
        ];
        const names: string[] = [];
        for (const statement of statements) {
          const plan = await tx.unsafe(`EXPLAIN (FORMAT JSON) ${statement}`);
          names.push(JSON.stringify(plan));
        }
        return names;
      });
      expect(planNames[0]).toContain("uq_students_school_normalized_admission_number");
      expect(planNames[1]).toContain("uq_teachers_school_normalized_employee_number");
      expect(planNames[2]).toContain("pk_parent_child_links");
      expect(planNames[3]).toContain("idx_parent_child_links_school_student_parent");
      expect(planNames[4]).toContain("uq_students_school_normalized_admission_number");

      const forbiddenColumns = await database.sql<{ name: string }[]>`
      SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema='app' AND table_name = ANY(${PROFILE_TABLES as unknown as string[]})
        AND (data_type IN ('ARRAY', 'json', 'jsonb') OR column_name ~
          '(guardian_[0-9]|phone|custody|emergency|age|gender|preferred_language)')
    `;
      expect(forbiddenColumns).toHaveLength(0);
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);
