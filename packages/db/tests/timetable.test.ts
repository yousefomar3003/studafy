import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");
const TIMETABLE_TABLES = ["timetable_versions", "timetable_slots"] as const;

type Database = Awaited<ReturnType<typeof testDatabase>>;
type Role = "studafy_admin" | "studafy_app";

interface TimetableFixture {
  school: string;
  year: string;
  term: string;
  teacher: string;
  secondTeacher: string;
  room: string;
  secondRoom: string;
  classId: string;
  secondClassId: string;
  version: string;
  user: string;
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

// Builds one school with a term, two teachers, two rooms, two classes, a fresh draft timetable
// version, and the admin user who will submit/approve it -- enough to exercise both EXCLUDE
// constraints and the full draft -> pending -> approved state machine.
async function createTimetableFixture(
  database: Database,
  school: string,
  suffix: string,
): Promise<TimetableFixture> {
  return asRole(database, "studafy_app", async (tx) => {
    await tx`SELECT set_config('app.school_id', ${school}, true)`;
    const userEmail = `staff-${suffix.toLowerCase()}@example.test`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${school}, ${userEmail}, ${userEmail}, 'active') RETURNING id
    `;
    const [teacherUserA] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${school}, ${`teacher-a-${suffix.toLowerCase()}@example.test`},
        ${`teacher-a-${suffix.toLowerCase()}@example.test`}, 'active') RETURNING id
    `;
    const [teacherUserB] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${school}, ${`teacher-b-${suffix.toLowerCase()}@example.test`},
        ${`teacher-b-${suffix.toLowerCase()}@example.test`}, 'active') RETURNING id
    `;
    const [teacher] = await tx<{ id: string }[]>`
      INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
      VALUES (${school}, ${teacherUserA!.id}, ${`EMP-A-${suffix}`}, 'active') RETURNING id
    `;
    const [secondTeacher] = await tx<{ id: string }[]>`
      INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
      VALUES (${school}, ${teacherUserB!.id}, ${`EMP-B-${suffix}`}, 'active') RETURNING id
    `;
    // status is 'planned', not 'active': uq_academic_years_one_active_per_school allows only one
    // active year per school, and the cross-term test calls this fixture twice for one school.
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${school}, ${`AY-${suffix}`}, ${`Academic Year ${suffix}`},
        '2026-08-01', '2027-06-30', 'planned') RETURNING id
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
      VALUES (${school}, ${`ROOM-A-${suffix}`}, 'Room A', 'physical', 30, 'Main', '1')
      RETURNING id
    `;
    const [secondRoom] = await tx<{ id: string }[]>`
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building, floor)
      VALUES (${school}, ${`ROOM-B-${suffix}`}, 'Room B', 'physical', 30, 'Main', '2')
      RETURNING id
    `;
    const [classRow] = await tx<{ id: string }[]>`
      INSERT INTO app.classes
        (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id,
         code, capacity, status)
      VALUES (${school}, ${course!.id}, ${year!.id}, ${term!.id}, ${teacher!.id}, ${room!.id},
        ${`CLASS-A-${suffix}`}, 25, 'active') RETURNING id
    `;
    const [secondClassRow] = await tx<{ id: string }[]>`
      INSERT INTO app.classes
        (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id,
         code, capacity, status)
      VALUES (${school}, ${course!.id}, ${year!.id}, ${term!.id}, ${teacher!.id}, ${room!.id},
        ${`CLASS-B-${suffix}`}, 25, 'active') RETURNING id
    `;
    const [version] = await tx<{ id: string }[]>`
      INSERT INTO app.timetable_versions (school_id, academic_year_id, term_id, name)
      VALUES (${school}, ${year!.id}, ${term!.id}, ${`Version ${suffix}`}) RETURNING id
    `;
    return {
      school,
      year: year!.id,
      term: term!.id,
      teacher: teacher!.id,
      secondTeacher: secondTeacher!.id,
      room: room!.id,
      secondRoom: secondRoom!.id,
      classId: classRow!.id,
      secondClassId: secondClassRow!.id,
      version: version!.id,
      user: user!.id,
    };
  });
}

integrationTest(
  "installs the timetable schema, ownership, grants, and forced policies",
  async () => {
    const database = await migratedDatabase();
    try {
      const enumRow = await database.sql<{ values: string[] }[]>`
        SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE n.nspname = 'app' AND t.typname = 'timetable_version_status'
        GROUP BY t.typname
      `;
      expect(enumRow[0]!.values).toEqual(["draft", "pending", "approved"]);

      const tables = await database.sql<
        { name: string; owner: string; rls: boolean; forced: boolean; appCrud: boolean }[]
      >`
        SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
          c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
          has_table_privilege('studafy_app',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS "appCrud"
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY(${TIMETABLE_TABLES as unknown as string[]})
        ORDER BY c.relname
      `;
      expect(tables.map((row) => row.name)).toEqual([...TIMETABLE_TABLES].sort());
      expect(
        tables.every(
          (row) => row.owner === "studafy_admin" && row.rls && row.forced && row.appCrud,
        ),
      ).toBe(true);

      const policies = await database.sql<{ tableName: string; name: string }[]>`
        SELECT c.relname AS "tableName", p.polname AS name
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relnamespace = 'app'::regnamespace
          AND c.relname = ANY(${TIMETABLE_TABLES as unknown as string[]})
      `;
      expect(policies).toHaveLength(2);
      expect(policies.every((policy) => policy.name === "tenant_isolation")).toBe(true);

      const excludeConstraints = await database.sql<{ name: string; definition: string }[]>`
        SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE connamespace = 'app'::regnamespace AND contype = 'x'
          AND conrelid = 'app.timetable_slots'::regclass
        ORDER BY conname
      `;
      expect(excludeConstraints.map((row) => row.name)).toEqual([
        "ex_timetable_slots_room_weekday_period",
        "ex_timetable_slots_teacher_weekday_period",
      ]);
      for (const row of excludeConstraints) expect(row.definition).toContain("USING gist");

      const triggerFunctions = await database.sql<{ name: string; appExecute: boolean }[]>`
        SELECT p.proname AS name,
          has_function_privilege('studafy_app', p.oid, 'EXECUTE') AS "appExecute"
        FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace
          AND p.proname IN (
            'enforce_timetable_version_transition',
            'enforce_timetable_slot_class_term',
            'enforce_timetable_slot_version_editable'
          )
      `;
      expect(triggerFunctions).toHaveLength(3);
      expect(triggerFunctions.every((row) => !row.appExecute)).toBe(true);
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "rejects overlapping teacher and room slots in the same version",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "timetable-overlap");
      const fixture = await createTimetableFixture(database, school, "OVL");

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${fixture.school}, true)`;
        await tx`
          INSERT INTO app.timetable_slots
            (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
          VALUES (${fixture.school}, ${fixture.version}, ${fixture.classId},
            ${fixture.teacher}, ${fixture.room}, 1, 1)
        `;
      });

      // Same teacher, same weekday/period, different room and class: still rejected.
      await expectDenied(
        database,
        `INSERT INTO app.timetable_slots
           (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
         VALUES ('${fixture.school}','${fixture.version}','${fixture.secondClassId}',
           '${fixture.teacher}','${fixture.secondRoom}',1,1)`,
        fixture.school,
      );

      // Same room, same weekday/period, different teacher and class: still rejected.
      await expectDenied(
        database,
        `INSERT INTO app.timetable_slots
           (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
         VALUES ('${fixture.school}','${fixture.version}','${fixture.secondClassId}',
           '${fixture.secondTeacher}','${fixture.room}',1,1)`,
        fixture.school,
      );

      // Different period: no conflict, both teacher and room are free.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${fixture.school}, true)`;
        await tx`
          INSERT INTO app.timetable_slots
            (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
          VALUES (${fixture.school}, ${fixture.version}, ${fixture.secondClassId},
            ${fixture.teacher}, ${fixture.room}, 1, 2)
        `;
        const [count] = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.timetable_slots
          WHERE timetable_version_id = ${fixture.version}
        `;
        expect(count?.count).toBe("2");
      });
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "lets two different versions independently reuse the same teacher and room",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "timetable-multi-version");
      const fixture = await createTimetableFixture(database, school, "MV");

      const secondVersion = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${fixture.school}, true)`;
        await tx`
          INSERT INTO app.timetable_slots
            (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
          VALUES (${fixture.school}, ${fixture.version}, ${fixture.classId},
            ${fixture.teacher}, ${fixture.room}, 1, 1)
        `;
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO app.timetable_versions (school_id, academic_year_id, term_id, name)
          VALUES (${fixture.school}, ${fixture.year}, ${fixture.term}, 'Version MV Alt')
          RETURNING id
        `;
        await tx`
          INSERT INTO app.timetable_slots
            (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
          VALUES (${fixture.school}, ${row!.id}, ${fixture.classId},
            ${fixture.teacher}, ${fixture.room}, 1, 1)
        `;
        return row!.id;
      });
      expect(secondVersion).not.toBe(fixture.version);
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "enforces the draft -> pending -> approved state machine and locks slots once out of draft",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "timetable-state-machine");
      const fixture = await createTimetableFixture(database, school, "SM");

      // Cannot skip straight to approved, and cannot insert a version already out of draft.
      await expectDenied(
        database,
        `INSERT INTO app.timetable_versions (school_id, academic_year_id, term_id, name, status)
         VALUES ('${fixture.school}','${fixture.year}','${fixture.term}','Bad Insert','approved')`,
        fixture.school,
      );
      await expectDenied(
        database,
        `UPDATE app.timetable_versions SET status = 'approved' WHERE id = '${fixture.version}'`,
        fixture.school,
      );

      // Submitting without an actor is rejected.
      await expectDenied(
        database,
        `UPDATE app.timetable_versions SET status = 'pending' WHERE id = '${fixture.version}'`,
        fixture.school,
      );

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${fixture.school}, true)`;
        await tx`
          INSERT INTO app.timetable_slots
            (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
          VALUES (${fixture.school}, ${fixture.version}, ${fixture.classId},
            ${fixture.teacher}, ${fixture.room}, 1, 1)
        `;
        await tx`
          UPDATE app.timetable_versions
          SET status = 'pending', submitted_by_user_id = ${fixture.user}
          WHERE id = ${fixture.version}
        `;
        const [row] = await tx<
          {
            status: string;
            submittedAt: Date | null;
            submittedBy: string | null;
          }[]
        >`
          SELECT status, submitted_at AS "submittedAt", submitted_by_user_id AS "submittedBy"
          FROM app.timetable_versions WHERE id = ${fixture.version}
        `;
        expect(row!.status).toBe("pending");
        expect(row!.submittedAt).not.toBeNull();
        expect(row!.submittedBy).toBe(fixture.user);
      });

      // Slots are frozen once the version is out of draft.
      await expectDenied(
        database,
        `INSERT INTO app.timetable_slots
           (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
         VALUES ('${fixture.school}','${fixture.version}','${fixture.secondClassId}',
           '${fixture.teacher}','${fixture.room}',2,1)`,
        fixture.school,
      );
      await expectDenied(
        database,
        `DELETE FROM app.timetable_slots WHERE timetable_version_id = '${fixture.version}'`,
        fixture.school,
      );

      // Reject the submission back to draft: audit columns clear, slots become editable again.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${fixture.school}, true)`;
        await tx`UPDATE app.timetable_versions SET status = 'draft' WHERE id = ${fixture.version}`;
        const [row] = await tx<{ submittedAt: Date | null }[]>`
          SELECT submitted_at AS "submittedAt" FROM app.timetable_versions WHERE id = ${fixture.version}
        `;
        expect(row!.submittedAt).toBeNull();
        await tx`
          INSERT INTO app.timetable_slots
            (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
          VALUES (${fixture.school}, ${fixture.version}, ${fixture.secondClassId},
            ${fixture.teacher}, ${fixture.room}, 2, 1)
        `;
        await tx`
          UPDATE app.timetable_versions
          SET status = 'pending', submitted_by_user_id = ${fixture.user}
          WHERE id = ${fixture.version}
        `;
      });

      // Approving without an actor is rejected; approving with one succeeds and is terminal.
      await expectDenied(
        database,
        `UPDATE app.timetable_versions SET status = 'approved' WHERE id = '${fixture.version}'`,
        fixture.school,
      );
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${fixture.school}, true)`;
        await tx`
          UPDATE app.timetable_versions
          SET status = 'approved', approved_by_user_id = ${fixture.user}
          WHERE id = ${fixture.version}
        `;
      });
      await expectDenied(
        database,
        `UPDATE app.timetable_versions SET status = 'draft' WHERE id = '${fixture.version}'`,
        fixture.school,
      );

      // A second version cannot also become approved for the same term.
      const otherVersion = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${fixture.school}, true)`;
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO app.timetable_versions (school_id, academic_year_id, term_id, name)
          VALUES (${fixture.school}, ${fixture.year}, ${fixture.term}, 'Version SM Second')
          RETURNING id
        `;
        await tx`
          UPDATE app.timetable_versions
          SET status = 'pending', submitted_by_user_id = ${fixture.user}
          WHERE id = ${row!.id}
        `;
        return row!.id;
      });
      await expectDenied(
        database,
        `UPDATE app.timetable_versions
         SET status = 'approved', approved_by_user_id = '${fixture.user}'
         WHERE id = '${otherVersion}'`,
        fixture.school,
      );
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "rejects a slot whose class term does not match its timetable version",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "timetable-cross-term");
      const a = await createTimetableFixture(database, school, "CTA");
      const b = await createTimetableFixture(database, school, "CTB");

      await expectDenied(
        database,
        `INSERT INTO app.timetable_slots
           (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
         VALUES ('${a.school}','${a.version}','${b.classId}','${a.teacher}','${a.room}',1,1)`,
        a.school,
        "studafy_admin",
      );
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "fails closed and isolates timetable tables across tenants",
  async () => {
    const database = await migratedDatabase();
    try {
      const schoolA = await createSchool(database, "timetable-tenant-a");
      const schoolB = await createSchool(database, "timetable-tenant-b");
      const a = await createTimetableFixture(database, schoolA, "TA");
      await createTimetableFixture(database, schoolB, "TB");

      for (const table of TIMETABLE_TABLES) {
        await expectDenied(database, `SELECT * FROM app.${table}`);
        await expectDenied(database, `SELECT * FROM app.${table}`, "not-a-uuid");
      }

      const hiddenVersions = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolB}, true)`;
        return tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.timetable_versions WHERE school_id = ${a.school}
        `;
      });
      expect(hiddenVersions[0]!.count).toBe("0");

      for (const statement of [
        "ALTER TABLE app.timetable_versions DISABLE ROW LEVEL SECURITY",
        "DROP POLICY tenant_isolation ON app.timetable_slots",
        "SELECT app.apply_tenant_isolation('app','timetable_slots')",
      ])
        await expectDenied(database, statement, a.school);
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);
