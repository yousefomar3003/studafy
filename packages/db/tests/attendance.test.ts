import { resolve } from "node:path";

import { expect, test } from "bun:test";

import {
  ensureAttendancePartitions,
  parseMonthsAhead,
  PARTITION_ADVISORY_LOCK_KEY,
} from "../src/attendance-partitions";
import { MigrationLockError } from "../src/errors";
import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");

const PARENTS = ["attendance_sessions", "attendance_records"] as const;
const REGISTRIES = ["attendance_session_keys", "attendance_record_keys"] as const;
const TENANT_POLICY = "(school_id = (current_setting('app.school_id'::text))::uuid)";

// The migration ships partitions for 2026-06 .. 2027-01, so every fixed timestamp below lands in a
// partition the migration itself created. Months outside that window are created explicitly by the
// tests that need them.
const JULY = "2026-07-15 12:00:00+00";
const JUNE = "2026-06-15 12:00:00+00";
const AUGUST = "2026-08-15 12:00:00+00";
const JULY_LAST_INSTANT = "2026-07-31 23:59:59.999999+00";
const AUGUST_FIRST_INSTANT = "2026-08-01 00:00:00+00";

type Database = Awaited<ReturnType<typeof testDatabase>>;
type Role = "studafy_admin" | "studafy_app";

interface Fixture {
  school: string;
  staffUser: string;
  classId: string;
  students: string[];
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
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

// Runs the statement inside a PL/pgSQL sub-transaction so a rejected statement does not poison the
// surrounding transaction, and fails the test if the database allowed it.
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

// Builds a school with one class and 40 enrolled students -- the roster size the ST-040 batch-insert
// target is stated against.
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
    const [teacher] = await tx<{ id: string }[]>`
      INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
      VALUES (${school}, ${teacherUser!.id}, ${`EMP-${suffix}`}, 'active') RETURNING id
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
      VALUES (${school}, ${`ROOM-${suffix}`}, 'Room', 'physical', 40, 'Main') RETURNING id
    `;
    const [classRow] = await tx<{ id: string }[]>`
      INSERT INTO app.classes
        (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id,
         code, capacity, status)
      VALUES (${school}, ${course!.id}, ${year!.id}, ${term!.id}, ${teacher!.id}, ${room!.id},
        ${`CLASS-${suffix}`}, 40, 'active') RETURNING id
    `;
    const students = await tx<{ id: string }[]>`
      WITH created_users AS (
        INSERT INTO app.users (school_id, email, normalized_email, status)
        SELECT ${school}::uuid,
               format('student-%s-%s@example.test', ordinal, ${lower}::text),
               format('student-%s-%s@example.test', ordinal, ${lower}::text),
               'active'
        FROM generate_series(1, 40) AS ordinal
        RETURNING id, normalized_email
      )
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
      SELECT ${school}::uuid, id, ${`STU-${suffix}-`}::text || normalized_email, 'First', 'Student'
      FROM created_users
      RETURNING id
    `;
    await tx`
      INSERT INTO app.enrollments (school_id, class_id, student_id)
      SELECT ${school}::uuid, ${classRow!.id}::uuid, student_id
      FROM unnest(${students.map((row) => row.id)}::uuid[]) AS student_id
    `;
    return {
      school,
      staffUser: staff!.id,
      classId: classRow!.id,
      students: students.map((row) => row.id),
    };
  });
}

async function createSession(
  database: Database,
  fixture: Fixture,
  options: { createdAt?: string; sessionDate?: string; period?: number | null } = {},
): Promise<{ id: string; createdAt: Date; partition: string }> {
  return asRole(database, "studafy_app", async (tx) => {
    await tx`SELECT set_config('app.school_id', ${fixture.school}, true)`;
    // A row whose created_at is written explicitly must write updated_at with it: the house
    // ck_<table>_timestamps constraint requires updated_at >= created_at, and a future-dated or
    // backdated created_at would otherwise be compared against a default of "now".
    const [row] = await tx<{ id: string; created_at: Date; partition: string }[]>`
      INSERT INTO app.attendance_sessions
        (school_id, class_id, session_date, period, status, taken_by_user_id,
         created_at, updated_at)
      VALUES (
        ${fixture.school}, ${fixture.classId},
        ${options.sessionDate ?? "2026-09-14"}, ${options.period ?? null}::smallint,
        'open', ${fixture.staffUser},
        COALESCE(${options.createdAt ?? null}::timestamptz, CURRENT_TIMESTAMP),
        COALESCE(${options.createdAt ?? null}::timestamptz, CURRENT_TIMESTAMP)
      )
      RETURNING id, created_at, tableoid::regclass::text AS partition
    `;
    return { id: row!.id, createdAt: row!.created_at, partition: row!.partition };
  });
}

async function createRecord(
  database: Database,
  fixture: Fixture,
  session: { id: string; createdAt: Date },
  studentId: string,
  createdAt = JULY,
): Promise<{ id: string; partition: string }> {
  return asRole(database, "studafy_app", async (tx) => {
    await tx`SELECT set_config('app.school_id', ${fixture.school}, true)`;
    const [row] = await tx<{ id: string; partition: string }[]>`
      INSERT INTO app.attendance_records
        (school_id, attendance_session_id, session_created_at, student_id, status,
         recorded_by_user_id, created_at, updated_at)
      VALUES (${fixture.school}, ${session.id}, ${session.createdAt}, ${studentId}, 'present',
        ${fixture.staffUser}, ${createdAt}::timestamptz, ${createdAt}::timestamptz)
      RETURNING id, tableoid::regclass::text AS partition
    `;
    return row!;
  });
}

function relationNames(node: PlanNode, found = new Set<string>()): Set<string> {
  if (node["Relation Name"]) found.add(node["Relation Name"]);
  for (const child of node.Plans ?? []) relationNames(child, found);
  return found;
}

async function explainRelations(
  database: Database,
  school: string,
  query: string,
): Promise<Set<string>> {
  return asRole(database, "studafy_app", async (tx) => {
    await tx`SELECT set_config('app.school_id', ${school}, true)`;
    await tx.unsafe("SET LOCAL enable_seqscan = off");
    const rows = await tx.unsafe<{ "QUERY PLAN": [{ Plan: PlanNode }] }[]>(
      `EXPLAIN (FORMAT JSON) ${query}`,
    );
    return relationNames(rows[0]!["QUERY PLAN"][0].Plan);
  });
}

test("attendance partition CLI accepts only a bounded integer horizon", () => {
  expect(parseMonthsAhead([])).toBe(3);
  expect(parseMonthsAhead(["0"])).toBe(0);
  expect(parseMonthsAhead(["24"])).toBe(24);
  expect(parseMonthsAhead(["-1"])).toBeUndefined();
  expect(parseMonthsAhead(["25"])).toBeUndefined();
  expect(parseMonthsAhead(["1.5"])).toBeUndefined();
  expect(parseMonthsAhead(["not-a-number"])).toBeUndefined();
  expect(parseMonthsAhead(["1", "2"])).toBeUndefined();
});

integrationTest(
  "both attendance parents are partitioned monthly by created_at",
  async () => {
    const database = await migratedDatabase();
    try {
      const rows = await database.sql<{ relname: string; strategy: string; key: string }[]>`
        SELECT parent.relname,
               partitioned.partstrat::text AS strategy,
               pg_catalog.pg_get_partkeydef(parent.oid) AS key
        FROM pg_catalog.pg_partitioned_table AS partitioned
        JOIN pg_catalog.pg_class AS parent ON parent.oid = partitioned.partrelid
        JOIN pg_catalog.pg_namespace AS ns ON ns.oid = parent.relnamespace
        WHERE ns.nspname = 'app' AND parent.relname = ANY(${[...PARENTS]})
        ORDER BY parent.relname
      `;
      expect(rows.map((row) => row.relname)).toEqual(["attendance_records", "attendance_sessions"]);
      for (const row of rows) {
        expect(row.strategy).toBe("r");
        expect(row.key).toBe("RANGE (created_at)");
      }

      // The migration's declared initial window: previous month, current month, six ahead.
      const partitions = await database.sql<{ relname: string }[]>`
        SELECT child.relname
        FROM pg_catalog.pg_inherits AS inherits
        JOIN pg_catalog.pg_class AS child ON child.oid = inherits.inhrelid
        JOIN pg_catalog.pg_class AS parent ON parent.oid = inherits.inhparent
        WHERE parent.relname = 'attendance_sessions'
        ORDER BY child.relname
      `;
      expect(partitions.map((row) => row.relname)).toEqual([
        "attendance_sessions_y2026m06",
        "attendance_sessions_y2026m07",
        "attendance_sessions_y2026m08",
        "attendance_sessions_y2026m09",
        "attendance_sessions_y2026m10",
        "attendance_sessions_y2026m11",
        "attendance_sessions_y2026m12",
        "attendance_sessions_y2027m01",
      ]);

      const constraints = await database.sql<{ table_name: string; constraints: string[] }[]>`
        SELECT c.relname AS table_name, array_agg(con.conname ORDER BY con.conname) AS constraints
        FROM pg_catalog.pg_constraint AS con
        JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
        JOIN pg_catalog.pg_namespace AS ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'app' AND c.relname = ANY(${[...PARENTS, ...REGISTRIES]})
        GROUP BY c.relname
        ORDER BY c.relname
      `;
      expect([...constraints]).toEqual([
        {
          table_name: "attendance_record_keys",
          constraints: ["fk_attendance_record_keys_school", "pk_attendance_record_keys"],
        },
        {
          table_name: "attendance_records",
          constraints: [
            "ck_attendance_records_minutes_late",
            "ck_attendance_records_reason",
            "ck_attendance_records_timestamps",
            "fk_attendance_records_recorded_by",
            "fk_attendance_records_school",
            "fk_attendance_records_session",
            "fk_attendance_records_student",
            "pk_attendance_records",
          ],
        },
        {
          table_name: "attendance_session_keys",
          constraints: [
            "ck_attendance_session_keys_period",
            "fk_attendance_session_keys_school",
            "uq_attendance_session_keys_business_key",
            "uq_attendance_session_keys_session",
          ],
        },
        {
          table_name: "attendance_sessions",
          constraints: [
            "ck_attendance_sessions_period",
            "ck_attendance_sessions_timestamps",
            "fk_attendance_sessions_class",
            "fk_attendance_sessions_school",
            "fk_attendance_sessions_taken_by",
            "pk_attendance_sessions",
            "uq_attendance_sessions_id_school_created",
          ],
        },
      ]);

      const triggers = await database.sql<
        { table_name: string; trigger_name: string; function_name: string }[]
      >`
        SELECT c.relname AS table_name, t.tgname AS trigger_name, p.proname AS function_name
        FROM pg_catalog.pg_trigger AS t
        JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
        JOIN pg_catalog.pg_proc AS p ON p.oid = t.tgfoid
        JOIN pg_catalog.pg_namespace AS ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'app' AND c.relname = ANY(${[...PARENTS]}) AND NOT t.tgisinternal
        ORDER BY c.relname, t.tgname
      `;
      expect([...triggers]).toEqual([
        {
          table_name: "attendance_records",
          trigger_name: "trg_attendance_records_sync_business_key",
          function_name: "sync_attendance_record_key",
        },
        {
          table_name: "attendance_sessions",
          trigger_name: "trg_attendance_sessions_sync_business_key",
          function_name: "sync_attendance_session_key",
        },
      ]);

      const parentIndexes = await database.sql<{ table_name: string; indexes: string[] }[]>`
        SELECT tablename AS table_name, array_agg(indexname ORDER BY indexname) AS indexes
        FROM pg_catalog.pg_indexes
        WHERE schemaname = 'app' AND tablename = ANY(${[...PARENTS]})
        GROUP BY tablename
        ORDER BY tablename
      `;
      expect([...parentIndexes]).toEqual([
        {
          table_name: "attendance_records",
          indexes: [
            "idx_attendance_records_school_recorded_by",
            "idx_attendance_records_school_session_student",
            "idx_attendance_records_school_student_created",
            "pk_attendance_records",
          ],
        },
        {
          table_name: "attendance_sessions",
          indexes: [
            "idx_attendance_sessions_school_class_date",
            "idx_attendance_sessions_school_taken_by",
            "pk_attendance_sessions",
            "uq_attendance_sessions_id_school_created",
          ],
        },
      ]);
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

integrationTest(
  "inserts through the parent route to the partition holding their created_at",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "routing-school");
      const fixture = await createFixture(database, school, "ROUTE");

      const june = await createSession(database, fixture, {
        createdAt: JUNE,
        sessionDate: "2026-06-10",
      });
      const july = await createSession(database, fixture, {
        createdAt: JULY,
        sessionDate: "2026-07-10",
      });
      const august = await createSession(database, fixture, {
        createdAt: AUGUST,
        sessionDate: "2026-08-10",
      });

      expect(june.partition).toBe("app.attendance_sessions_y2026m06");
      expect(july.partition).toBe("app.attendance_sessions_y2026m07");
      expect(august.partition).toBe("app.attendance_sessions_y2026m08");

      // Half-open bounds: the last representable instant of July stays in July, and the first instant
      // of August is already the next partition.
      const lastOfJuly = await createSession(database, fixture, {
        createdAt: JULY_LAST_INSTANT,
        sessionDate: "2026-07-31",
      });
      const firstOfAugust = await createSession(database, fixture, {
        createdAt: AUGUST_FIRST_INSTANT,
        sessionDate: "2026-08-01",
      });
      expect(lastOfJuly.partition).toBe("app.attendance_sessions_y2026m07");
      expect(firstOfAugust.partition).toBe("app.attendance_sessions_y2026m08");

      // A record's own created_at routes it, independently of the session it belongs to: a July
      // session corrected in August puts the correction row in the August partition.
      const record = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [row] = await tx<{ partition: string }[]>`
          INSERT INTO app.attendance_records
            (school_id, attendance_session_id, session_created_at, student_id, status,
             created_at, updated_at)
          VALUES (${school}, ${july.id}, ${july.createdAt}, ${fixture.students[0]!}, 'present',
            ${AUGUST}::timestamptz, ${AUGUST}::timestamptz)
          RETURNING tableoid::regclass::text AS partition
        `;
        return row!.partition;
      });
      expect(record).toBe("app.attendance_records_y2026m08");

      // Partitioned parents never store rows themselves.
      const [parentRows] = await database.sql<{ sessions: string; records: string }[]>`
        SELECT
          (SELECT count(*) FROM ONLY app.attendance_sessions) AS sessions,
          (SELECT count(*) FROM ONLY app.attendance_records) AS records
      `;
      expect(parentRows!.sessions).toBe("0");
      expect(parentRows!.records).toBe("0");
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

integrationTest(
  "a month with no partition fails clearly and succeeds after maintenance",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "missing-partition-school");
      const fixture = await createFixture(database, school, "MISS");

      // 2030-05 is far outside the migration's initial window. No DEFAULT partition exists, so the
      // insert must fail loudly rather than being silently absorbed.
      let failure = "unexpectedly succeeded";
      try {
        await asRole(database, "studafy_app", async (tx) => {
          await tx`SELECT set_config('app.school_id', ${school}, true)`;
          await tx`
            INSERT INTO app.attendance_sessions
              (school_id, class_id, session_date, status, created_at, updated_at)
            VALUES (${school}, ${fixture.classId}, '2030-05-10', 'open',
              '2030-05-10 09:00:00+00'::timestamptz, '2030-05-10 09:00:00+00'::timestamptz)
          `;
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : "unknown";
      }
      expect(failure).toContain("no partition of relation");

      await asRole(database, "studafy_admin", async (tx) => {
        await tx`SELECT app.create_attendance_partitions('2030-05-01')`;
      });

      const session = await createSession(database, fixture, {
        createdAt: "2030-05-10 09:00:00+00",
        sessionDate: "2030-05-10",
      });
      expect(session.partition).toBe("app.attendance_sessions_y2030m05");
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

integrationTest(
  "maintenance is idempotent, covers year and leap-year boundaries, and refuses incompatible bounds",
  async () => {
    const database = await migratedDatabase();
    try {
      // December -> January and a leap-year February.
      const created = await asRole(database, "studafy_admin", async (tx) => {
        const rows = await tx<{ created: string[] }[]>`
          SELECT app.create_attendance_partitions('2027-12-01')
            || app.create_attendance_partitions('2028-01-01')
            || app.create_attendance_partitions('2028-02-01') AS created
        `;
        return rows[0]!.created;
      });
      expect(created).toEqual([
        "attendance_sessions_y2027m12",
        "attendance_records_y2027m12",
        "attendance_sessions_y2028m01",
        "attendance_records_y2028m01",
        "attendance_sessions_y2028m02",
        "attendance_records_y2028m02",
      ]);

      const bounds = await database.sql<{ bounds: string }[]>`
        SELECT pg_catalog.pg_get_expr(child.relpartbound, child.oid) AS bounds
        FROM pg_catalog.pg_class AS child
        JOIN pg_catalog.pg_namespace AS ns ON ns.oid = child.relnamespace
        WHERE ns.nspname = 'app' AND child.relname = 'attendance_sessions_y2028m02'
      `;
      // Half-open, so a leap day is inside February's partition and March starts the next one.
      expect(bounds[0]!.bounds).toContain("'2028-02-01 00:00:00+00'");
      expect(bounds[0]!.bounds).toContain("'2028-03-01 00:00:00+00'");

      // Running the same month again creates nothing and raises nothing.
      const second = await asRole(database, "studafy_admin", async (tx) => {
        const rows = await tx<{ created: string[] }[]>`
          SELECT app.create_attendance_partitions('2028-02-01') AS created
        `;
        return rows[0]!.created;
      });
      expect(second).toEqual([]);

      // A real partition with the expected name but incompatible bounds must raise, never be altered.
      await asRole(database, "studafy_admin", async (tx) => {
        await tx.unsafe(`
          CREATE TABLE app.attendance_sessions_y2029m03
          PARTITION OF app.attendance_sessions
          FOR VALUES FROM ('2029-04-01 00:00:00+00') TO ('2029-05-01 00:00:00+00')
        `);
      });
      await expectDenied(
        database,
        "SELECT app.create_attendance_partitions('2029-03-01')",
        undefined,
        "studafy_admin",
      );
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

integrationTest(
  "maintenance shares the migration lock and never logs connection credentials",
  async () => {
    const database = await migratedDatabase();
    const held = await database.sql.reserve();
    let lockHeld = false;
    try {
      const [lock] = await held<{ acquired: boolean }[]>`
        SELECT pg_catalog.pg_try_advisory_lock(${PARTITION_ADVISORY_LOCK_KEY.toString()}) AS acquired
      `;
      expect(lock!.acquired).toBe(true);
      lockHeld = true;
      await expect(
        ensureAttendancePartitions(0, {
          env: runnerEnv(database.url, repositoryMigrations),
          log: () => undefined,
        }),
      ).rejects.toBeInstanceOf(MigrationLockError);

      await held`SELECT pg_catalog.pg_advisory_unlock(${PARTITION_ADVISORY_LOCK_KEY.toString()})`;
      lockHeld = false;
      const logs: string[] = [];
      await ensureAttendancePartitions(0, {
        env: runnerEnv(database.url, repositoryMigrations),
        log: (line) => logs.push(line),
      });
      const output = logs.join("\n");
      expect(output).toContain("attendance partition(s) already present");
      expect(output).not.toContain(database.url);
      expect(output).not.toContain(new URL(database.url).password);
    } finally {
      if (lockHeld) {
        await held`SELECT pg_catalog.pg_advisory_unlock(${PARTITION_ADVISORY_LOCK_KEY.toString()})`;
      }
      held.release();
      await database.cleanup();
    }
  },
  60_000,
);

integrationTest(
  "every partition carries the parent's ownership, grants, forced RLS, policy and indexes",
  async () => {
    const database = await migratedDatabase();
    try {
      // A partition created after the migration, by the maintenance helper, must be indistinguishable
      // from one the migration made -- that is the whole security contract of the helper.
      await ensureAttendancePartitions(0, {
        env: runnerEnv(database.url, repositoryMigrations),
        log: () => undefined,
      });
      await asRole(database, "studafy_admin", async (tx) => {
        await tx`SELECT app.create_attendance_partitions('2029-09-01')`;
      });

      const rows = await database.sql<
        {
          relname: string;
          owner: string;
          rls: boolean;
          forced: boolean;
          policy: string | null;
          app_select: boolean;
          app_insert: boolean;
          app_update: boolean;
          app_delete: boolean;
          public_select: boolean;
          index_count: string;
        }[]
      >`
        SELECT child.relname,
               pg_catalog.pg_get_userbyid(child.relowner) AS owner,
               child.relrowsecurity AS rls,
               child.relforcerowsecurity AS forced,
               (SELECT pg_catalog.pg_get_expr(p.polqual, p.polrelid)
                  FROM pg_catalog.pg_policy AS p
                 WHERE p.polrelid = child.oid AND p.polname = 'tenant_isolation') AS policy,
               pg_catalog.has_table_privilege('studafy_app', child.oid, 'SELECT') AS app_select,
               pg_catalog.has_table_privilege('studafy_app', child.oid, 'INSERT') AS app_insert,
               pg_catalog.has_table_privilege('studafy_app', child.oid, 'UPDATE') AS app_update,
               pg_catalog.has_table_privilege('studafy_app', child.oid, 'DELETE') AS app_delete,
               pg_catalog.has_table_privilege('public', child.oid, 'SELECT') AS public_select,
               (SELECT count(*) FROM pg_catalog.pg_index AS i WHERE i.indrelid = child.oid)
                 AS index_count
        FROM pg_catalog.pg_inherits AS inherits
        JOIN pg_catalog.pg_class AS child ON child.oid = inherits.inhrelid
        JOIN pg_catalog.pg_class AS parent ON parent.oid = inherits.inhparent
        JOIN pg_catalog.pg_namespace AS ns ON ns.oid = parent.relnamespace
        WHERE ns.nspname = 'app' AND parent.relname = ANY(${[...PARENTS]})
        ORDER BY child.relname
      `;

      expect(rows.length).toBeGreaterThanOrEqual(18);
      expect(rows.some((row) => row.relname === "attendance_sessions_y2029m09")).toBe(true);
      for (const row of rows) {
        expect(row.owner).toBe("studafy_admin");
        expect(row.rls).toBe(true);
        expect(row.forced).toBe(true);
        expect(row.policy).toBe(TENANT_POLICY);
        // studafy_app CAN name a partition directly -- which is exactly why forced RLS above matters.
        expect(row.app_select).toBe(true);
        expect(row.app_insert).toBe(true);
        expect(row.app_update).toBe(true);
        expect(row.app_delete).toBe(true);
        expect(row.public_select).toBe(false);
        // Sessions: pkey + candidate key + 2 declared indexes. Records: pkey + 3 declared indexes.
        expect(row.index_count).toBe(row.relname.startsWith("attendance_sessions") ? "4" : "4");
      }

      // The parents and the registries themselves.
      const parents = await database.sql<
        {
          relname: string;
          owner: string;
          rls: boolean;
          forced: boolean;
          policy: string | null;
          app_select: boolean;
          app_insert: boolean;
          app_update: boolean;
          app_delete: boolean;
          public_select: boolean;
        }[]
      >`
        SELECT c.relname, pg_catalog.pg_get_userbyid(c.relowner) AS owner,
               c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
               (SELECT pg_catalog.pg_get_expr(p.polqual, p.polrelid)
                  FROM pg_catalog.pg_policy AS p
                 WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy,
               pg_catalog.has_table_privilege('studafy_app', c.oid, 'SELECT') AS app_select,
               pg_catalog.has_table_privilege('studafy_app', c.oid, 'INSERT') AS app_insert,
               pg_catalog.has_table_privilege('studafy_app', c.oid, 'UPDATE') AS app_update,
               pg_catalog.has_table_privilege('studafy_app', c.oid, 'DELETE') AS app_delete,
               pg_catalog.has_table_privilege('public', c.oid, 'SELECT') AS public_select
        FROM pg_catalog.pg_class AS c
        JOIN pg_catalog.pg_namespace AS ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'app' AND c.relname = ANY(${[...PARENTS, ...REGISTRIES]})
      `;
      expect(parents.length).toBe(4);
      for (const row of parents) {
        const registry = REGISTRIES.includes(row.relname as (typeof REGISTRIES)[number]);
        expect(row.owner).toBe("studafy_admin");
        expect(row.rls).toBe(true);
        expect(row.forced).toBe(true);
        expect(row.policy).toBe(TENANT_POLICY);
        expect(row.app_select).toBe(true);
        expect(row.app_insert).toBe(!registry);
        expect(row.app_update).toBe(!registry);
        expect(row.app_delete).toBe(!registry);
        expect(row.public_select).toBe(false);
      }

      const functions = await database.sql<
        {
          name: string;
          owner: string;
          security_definer: boolean;
          app_execute: boolean;
          public_execute: boolean;
        }[]
      >`
        SELECT p.proname AS name, pg_catalog.pg_get_userbyid(p.proowner) AS owner,
               p.prosecdef AS security_definer,
               pg_catalog.has_function_privilege('studafy_app', p.oid, 'EXECUTE') AS app_execute,
               pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
        FROM pg_catalog.pg_proc AS p
        JOIN pg_catalog.pg_namespace AS ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'app'
          AND p.proname = ANY(${[
            "create_attendance_partitions",
            "ensure_attendance_partitions",
            "sync_attendance_record_key",
            "sync_attendance_session_key",
          ]})
        ORDER BY p.proname
      `;
      expect(functions.map((row) => row.name)).toEqual([
        "create_attendance_partitions",
        "ensure_attendance_partitions",
        "sync_attendance_record_key",
        "sync_attendance_session_key",
      ]);
      for (const row of functions) {
        expect(row.owner).toBe("studafy_admin");
        expect(row.security_definer).toBe(row.name.startsWith("sync_"));
        expect(row.app_execute).toBe(false);
        expect(row.public_execute).toBe(false);
      }

      const enumPrivileges = await database.sql<
        { name: string; owner: string; app_usage: boolean; public_usage: boolean }[]
      >`
        SELECT t.typname AS name, pg_catalog.pg_get_userbyid(t.typowner) AS owner,
               pg_catalog.has_type_privilege('studafy_app', t.oid, 'USAGE') AS app_usage,
               pg_catalog.has_type_privilege('public', t.oid, 'USAGE') AS public_usage
        FROM pg_catalog.pg_type AS t
        JOIN pg_catalog.pg_namespace AS ns ON ns.oid = t.typnamespace
        WHERE ns.nspname = 'app'
          AND t.typname IN ('attendance_session_status', 'attendance_status')
        ORDER BY t.typname
      `;
      expect([...enumPrivileges]).toEqual([
        {
          name: "attendance_session_status",
          owner: "studafy_admin",
          app_usage: true,
          public_usage: false,
        },
        {
          name: "attendance_status",
          owner: "studafy_admin",
          app_usage: true,
          public_usage: false,
        },
      ]);
    } finally {
      await database.cleanup();
    }
  },
  90_000,
);

integrationTest(
  "tenant isolation holds through the parent and through a partition named directly",
  async () => {
    const database = await migratedDatabase();
    try {
      const schoolA = await createSchool(database, "tenant-school-a");
      const schoolB = await createSchool(database, "tenant-school-b");
      const fixtureA = await createFixture(database, schoolA, "AAA");
      const fixtureB = await createFixture(database, schoolB, "BBB");

      const sessionA = await createSession(database, fixtureA, {
        createdAt: JULY,
        sessionDate: "2026-07-01",
      });
      const sessionB = await createSession(database, fixtureB, {
        createdAt: JULY,
        sessionDate: "2026-07-01",
      });
      const recordA = await createRecord(database, fixtureA, sessionA, fixtureA.students[0]!);
      await createRecord(database, fixtureB, sessionB, fixtureB.students[0]!);

      // School A sees only its own row, through the parent...
      const throughParent = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        return tx<{ id: string }[]>`SELECT id FROM app.attendance_sessions`;
      });
      expect(throughParent.map((row) => row.id)).toEqual([sessionA.id]);

      // ...and when it names the July partition directly, which is the bypass the ticket asks about.
      const throughPartition = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        return tx<{ id: string }[]>`SELECT id FROM app.attendance_sessions_y2026m07`;
      });
      expect(throughPartition.map((row) => row.id)).toEqual([sessionA.id]);

      const recordsThroughParent = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        return tx<{ id: string }[]>`SELECT id FROM app.attendance_records`;
      });
      expect(recordsThroughParent.map((row) => row.id)).toEqual([recordA.id]);
      const recordsThroughPartition = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        return tx<{ id: string }[]>`SELECT id FROM app.attendance_records_y2026m07`;
      });
      expect(recordsThroughPartition.map((row) => row.id)).toEqual([recordA.id]);

      // Writing another school's row into a partition directly is refused by that partition's own
      // WITH CHECK, not by the parent's.
      await expectDenied(
        database,
        `INSERT INTO app.attendance_sessions_y2026m07
           (school_id, class_id, session_date, status, created_at, updated_at)
         VALUES ('${schoolB}', '${fixtureB.classId}', '2026-07-02', 'open',
           '${JULY}'::timestamptz, '${JULY}'::timestamptz)`,
        schoolA,
      );
      await expectDenied(
        database,
        `INSERT INTO app.attendance_records_y2026m07
           (school_id, attendance_session_id, session_created_at, student_id, status,
            created_at, updated_at)
         VALUES ('${schoolB}', '${sessionB.id}', '${sessionB.createdAt.toISOString()}',
           '${fixtureB.students[1]!}', 'present', '${JULY}'::timestamptz,
           '${JULY}'::timestamptz)`,
        schoolA,
      );

      // Cross-tenant writes are invisible rather than erroring: the policy's USING clause removes the
      // other school's rows from the statement's scope, so an UPDATE or DELETE aimed at School B from
      // School A's context matches nothing. Mutating a row's own school_id, by contrast, is refused
      // outright by the policy's WITH CHECK.
      const updated = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        return tx`UPDATE app.attendance_sessions SET status = 'locked' WHERE school_id = ${schoolB}`;
      });
      expect(updated.count).toBe(0);
      const deleted = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        return tx`DELETE FROM app.attendance_sessions WHERE school_id = ${schoolB}`;
      });
      expect(deleted.count).toBe(0);
      const recordsUpdated = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        return tx`
          UPDATE app.attendance_records_y2026m07
          SET status = 'absent' WHERE school_id = ${schoolB}
        `;
      });
      expect(recordsUpdated.count).toBe(0);
      const recordsDeleted = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        return tx`DELETE FROM app.attendance_records_y2026m07 WHERE school_id = ${schoolB}`;
      });
      expect(recordsDeleted.count).toBe(0);
      await expectDenied(
        database,
        `UPDATE app.attendance_sessions SET school_id = '${schoolB}' WHERE id = '${sessionA.id}'`,
        schoolA,
      );
      await expectDenied(
        database,
        `UPDATE app.attendance_records SET school_id = '${schoolB}' WHERE id = '${recordA.id}'`,
        schoolA,
      );

      // Fail-closed context: no GUC and a non-uuid GUC both raise rather than returning everything.
      await expectDenied(database, "SELECT count(*) FROM app.attendance_sessions");
      await expectDenied(database, "SELECT count(*) FROM app.attendance_records");
      await expectDenied(database, "SELECT count(*) FROM app.attendance_sessions_y2026m07");
      await expectDenied(database, "SELECT count(*) FROM app.attendance_records_y2026m07");
      await expectDenied(database, "SELECT count(*) FROM app.attendance_sessions", "not-a-uuid");
      await expectDenied(database, "SELECT count(*) FROM app.attendance_records", "not-a-uuid");
    } finally {
      await database.cleanup();
    }
  },
  90_000,
);

integrationTest(
  "the runtime role cannot manage partitions, policies or RLS",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "privilege-school");

      const denied = [
        "SELECT app.create_attendance_partitions('2031-01-01')",
        "SELECT app.ensure_attendance_partitions(1)",
        "SELECT app.apply_tenant_isolation('app', 'attendance_sessions')",
        "ALTER TABLE app.attendance_sessions DISABLE ROW LEVEL SECURITY",
        "ALTER TABLE app.attendance_sessions_y2026m07 DISABLE ROW LEVEL SECURITY",
        "ALTER TABLE app.attendance_sessions NO FORCE ROW LEVEL SECURITY",
        "DROP POLICY tenant_isolation ON app.attendance_sessions",
        "DROP POLICY tenant_isolation ON app.attendance_sessions_y2026m07",
        "CREATE POLICY sneaky ON app.attendance_records USING (true)",
        "ALTER TABLE app.attendance_sessions DETACH PARTITION app.attendance_sessions_y2026m07",
        "DROP TABLE app.attendance_sessions_y2026m07",
        "CREATE TABLE app.attendance_sessions_y2031m01 PARTITION OF app.attendance_sessions " +
          "FOR VALUES FROM ('2031-01-01+00') TO ('2031-02-01+00')",
        "CREATE INDEX idx_sneaky ON app.attendance_records (status)",
        "DROP INDEX app.idx_attendance_sessions_school_class_date",
        // The registries are the only enforcement of the attendance business keys. If the runtime role
        // could write them, it could park a key to block a legitimate session, or remove one to admit
        // the duplicate the registry exists to prevent. Only the SECURITY DEFINER triggers write here.
        `INSERT INTO app.attendance_session_keys
           (school_id, class_id, session_date, attendance_session_id, session_created_at)
         VALUES ('${school}', gen_random_uuid(), '2026-07-09', gen_random_uuid(),
           CURRENT_TIMESTAMP)`,
        "DELETE FROM app.attendance_session_keys",
        "DELETE FROM app.attendance_record_keys",
        "UPDATE app.attendance_session_keys SET session_date = '2026-07-08'",
      ];
      for (const statement of denied) await expectDenied(database, statement, school);

      // ...but it may read them, which is how a caller pre-checks a conflict before writing.
      const readable = await database.sql<{ session_keys: boolean; record_keys: boolean }[]>`
        SELECT
          pg_catalog.has_table_privilege('studafy_app', 'app.attendance_session_keys', 'SELECT')
            AS session_keys,
          pg_catalog.has_table_privilege('studafy_app', 'app.attendance_record_keys', 'SELECT')
            AS record_keys
      `;
      expect(readable[0]!.session_keys).toBe(true);
      expect(readable[0]!.record_keys).toBe(true);

      // PUBLIC has no EXECUTE on the maintenance helpers either.
      const [grants] = await database.sql<{ create_fn: boolean; ensure_fn: boolean }[]>`
        SELECT
          pg_catalog.has_function_privilege('public',
            'app.create_attendance_partitions(date)', 'EXECUTE') AS create_fn,
          pg_catalog.has_function_privilege('public',
            'app.ensure_attendance_partitions(integer)', 'EXECUTE') AS ensure_fn
      `;
      expect(grants!.create_fn).toBe(false);
      expect(grants!.ensure_fn).toBe(false);
    } finally {
      await database.cleanup();
    }
  },
  90_000,
);

integrationTest(
  "composite foreign keys reject cross-school links even for the administrative role",
  async () => {
    const database = await migratedDatabase();
    try {
      const schoolA = await createSchool(database, "fk-school-a");
      const schoolB = await createSchool(database, "fk-school-b");
      const fixtureA = await createFixture(database, schoolA, "FKA");
      const fixtureB = await createFixture(database, schoolB, "FKB");

      const sessionB = await createSession(database, fixtureB, {
        createdAt: JULY,
        sessionDate: "2026-07-03",
      });
      const sessionA = await createSession(database, fixtureA, {
        createdAt: JULY,
        sessionDate: "2026-07-03",
      });

      // These fail on the foreign key, not on RLS: they are run as studafy_admin, with School A's
      // context set, so RLS would have permitted the row's own school_id.
      await expectDenied(
        database,
        `INSERT INTO app.attendance_sessions
           (school_id, class_id, session_date, status, created_at, updated_at)
         VALUES ('${schoolA}', '${fixtureB.classId}', '2026-07-04', 'open',
           '${JULY}'::timestamptz, '${JULY}'::timestamptz)`,
        schoolA,
        "studafy_admin",
      );
      await expectDenied(
        database,
        `INSERT INTO app.attendance_records
           (school_id, attendance_session_id, session_created_at, student_id, status,
            created_at, updated_at)
         VALUES ('${schoolA}', '${sessionA.id}', '${sessionA.createdAt.toISOString()}',
           '${fixtureB.students[0]!}', 'present', '${JULY}'::timestamptz, '${JULY}'::timestamptz)`,
        schoolA,
        "studafy_admin",
      );
      await expectDenied(
        database,
        `INSERT INTO app.attendance_records
           (school_id, attendance_session_id, session_created_at, student_id, status,
            created_at, updated_at)
         VALUES ('${schoolA}', '${sessionB.id}', '${sessionB.createdAt.toISOString()}',
           '${fixtureA.students[0]!}', 'present', '${JULY}'::timestamptz, '${JULY}'::timestamptz)`,
        schoolA,
        "studafy_admin",
      );
      await expectDenied(
        database,
        `INSERT INTO app.attendance_sessions
           (school_id, class_id, session_date, status, taken_by_user_id, created_at, updated_at)
         VALUES ('${schoolA}', '${fixtureA.classId}', '2026-07-05', 'open',
           '${fixtureB.staffUser}', '${JULY}'::timestamptz, '${JULY}'::timestamptz)`,
        schoolA,
        "studafy_admin",
      );
      await expectDenied(
        database,
        `INSERT INTO app.attendance_records
           (school_id, attendance_session_id, session_created_at, student_id, status,
            recorded_by_user_id, created_at, updated_at)
         VALUES ('${schoolA}', '${sessionA.id}', '${sessionA.createdAt.toISOString()}',
           '${fixtureA.students[1]!}', 'present', '${fixtureB.staffUser}',
           '${JULY}'::timestamptz, '${JULY}'::timestamptz)`,
        schoolA,
        "studafy_admin",
      );
    } finally {
      await database.cleanup();
    }
  },
  90_000,
);

integrationTest(
  "the unpartitioned registries enforce the business keys across partitions",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "uniqueness-school");
      const fixture = await createFixture(database, school, "UNQ");

      const session = await createSession(database, fixture, {
        createdAt: JULY,
        sessionDate: "2026-09-14",
        period: null,
      });

      // The duplicate is created in a DIFFERENT month, so it would land in a different partition. A
      // partition-local unique constraint could not see it; the registry can.
      await expectDenied(
        database,
        `INSERT INTO app.attendance_sessions
           (school_id, class_id, session_date, status, created_at, updated_at)
         VALUES ('${school}', '${fixture.classId}', '2026-09-14', 'open',
           '${AUGUST}'::timestamptz, '${AUGUST}'::timestamptz)`,
        school,
      );

      // A different period on the same class and date is a different session and is allowed; a repeat
      // of that period is not.
      const periodSession = await createSession(database, fixture, {
        createdAt: JULY,
        sessionDate: "2026-09-14",
        period: 3,
      });
      await expectDenied(
        database,
        `INSERT INTO app.attendance_sessions
           (school_id, class_id, session_date, period, status, created_at, updated_at)
         VALUES ('${school}', '${fixture.classId}', '2026-09-14', 3, 'open',
           '${AUGUST}'::timestamptz, '${AUGUST}'::timestamptz)`,
        school,
      );

      const movedSession = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [row] = await tx<{ partition: string }[]>`
          UPDATE app.attendance_sessions
          SET created_at = ${AUGUST}::timestamptz, updated_at = ${AUGUST}::timestamptz
          WHERE id = ${periodSession.id} AND created_at = ${periodSession.createdAt}
          RETURNING tableoid::regclass::text AS partition
        `;
        return row!.partition;
      });
      expect(movedSession).toBe("app.attendance_sessions_y2026m08");
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        await tx`DELETE FROM app.attendance_sessions WHERE id = ${periodSession.id}`;
      });
      await createSession(database, fixture, {
        createdAt: JULY,
        sessionDate: "2026-09-14",
        period: 3,
      });

      const createdAt = session.createdAt.toISOString();
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        await tx`
          INSERT INTO app.attendance_records
            (school_id, attendance_session_id, session_created_at, student_id, status,
             created_at, updated_at)
          VALUES (${school}, ${session.id}, ${session.createdAt}, ${fixture.students[0]!},
            'present', ${JULY}::timestamptz, ${JULY}::timestamptz)
        `;
      });
      // Same session, same student, different month -> different partition, still rejected.
      await expectDenied(
        database,
        `INSERT INTO app.attendance_records
           (school_id, attendance_session_id, session_created_at, student_id, status,
            created_at, updated_at)
         VALUES ('${school}', '${session.id}', '${createdAt}', '${fixture.students[0]!}',
           'absent', '${AUGUST}'::timestamptz, '${AUGUST}'::timestamptz)`,
        school,
      );

      // A session with recorded outcomes cannot be deleted because the record's tenant-safe session
      // foreign key targets its registry row, which the session delete trigger must remove.
      await expectDenied(
        database,
        `DELETE FROM app.attendance_sessions WHERE id = '${session.id}'`,
        school,
      );

      // Deleting the record releases the key again.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        await tx`
          DELETE FROM app.attendance_records
          WHERE school_id = ${school} AND student_id = ${fixture.students[0]!}
        `;
        await tx`
          INSERT INTO app.attendance_records
            (school_id, attendance_session_id, session_created_at, student_id, status,
             created_at, updated_at)
          VALUES (${school}, ${session.id}, ${session.createdAt}, ${fixture.students[0]!},
            'absent', ${AUGUST}::timestamptz, ${AUGUST}::timestamptz)
        `;
      });

      const movedRecord = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [row] = await tx<{ partition: string; created_at: Date }[]>`
          UPDATE app.attendance_records
          SET created_at = '2026-09-15 12:00:00+00'::timestamptz,
              updated_at = '2026-09-15 12:00:00+00'::timestamptz
          WHERE attendance_session_id = ${session.id} AND student_id = ${fixture.students[0]!}
          RETURNING tableoid::regclass::text AS partition, created_at
        `;
        return row!;
      });
      expect(movedRecord.partition).toBe("app.attendance_records_y2026m09");

      const [registry] = await database.sql<
        { sessions: string; records: string; record_created_at: Date }[]
      >`
        SELECT
          (SELECT count(*) FROM app.attendance_session_keys) AS sessions,
          (SELECT count(*) FROM app.attendance_record_keys) AS records,
          (SELECT record_created_at FROM app.attendance_record_keys LIMIT 1) AS record_created_at
      `;
      expect(registry!.sessions).toBe("2");
      expect(registry!.records).toBe("1");
      expect(registry!.record_created_at.toISOString()).toBe(movedRecord.created_at.toISOString());
    } finally {
      await database.cleanup();
    }
  },
  90_000,
);

integrationTest(
  "attendance is stored relationally: no rosters, no duplicated metadata, no derived totals",
  async () => {
    const database = await migratedDatabase();
    try {
      const columns = await database.sql<{ table_name: string; column_name: string }[]>`
        SELECT c.relname AS table_name, a.attname AS column_name
        FROM pg_catalog.pg_attribute AS a
        JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace AS ns ON ns.oid = c.relnamespace
        JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
        WHERE ns.nspname = 'app'
          AND c.relname = ANY(${[...PARENTS]})
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND (t.typcategory = 'A' OR t.typname IN ('json', 'jsonb'))
      `;
      // 1NF: no array of statuses, no JSONB roster, no comma-separated absentee list.
      expect(columns).toHaveLength(0);

      const sessionColumns = await database.sql<{ column_name: string }[]>`
        SELECT a.attname AS column_name
        FROM pg_catalog.pg_attribute AS a
        JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace AS ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'app' AND c.relname = 'attendance_sessions'
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `;
      // 2NF/3NF: only attributes of the attendance-taking event itself. No class name, no course or
      // teacher name, no school slug, no present/absent counts, no attendance percentage.
      expect(sessionColumns.map((row) => row.column_name)).toEqual([
        "id",
        "school_id",
        "class_id",
        "session_date",
        "period",
        "status",
        "taken_by_user_id",
        "created_at",
        "updated_at",
      ]);

      const recordColumns = await database.sql<{ column_name: string }[]>`
        SELECT a.attname AS column_name
        FROM pg_catalog.pg_attribute AS a
        JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace AS ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'app' AND c.relname = 'attendance_records'
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `;
      // No student name or admission number, no class_id, no attendance_date: all reachable through
      // the session or the student. session_created_at is the one structural duplication and exists
      // only because a foreign key to a partitioned table must include its partition key.
      expect(recordColumns.map((row) => row.column_name)).toEqual([
        "id",
        "school_id",
        "attendance_session_id",
        "session_created_at",
        "student_id",
        "status",
        "minutes_late",
        "reason",
        "recorded_by_user_id",
        "created_at",
        "updated_at",
      ]);
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

integrationTest(
  "attendance status vocabularies are constrained and invalid values are rejected",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "status-school");
      const fixture = await createFixture(database, school, "STA");
      const session = await createSession(database, fixture, {
        createdAt: JULY,
        sessionDate: "2026-07-20",
      });

      const [enums] = await database.sql<{ session_status: string[]; record_status: string[] }[]>`
        SELECT
          (SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
             FROM pg_catalog.pg_enum AS e
             JOIN pg_catalog.pg_type AS t ON t.oid = e.enumtypid
            WHERE t.typname = 'attendance_session_status') AS session_status,
          (SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
             FROM pg_catalog.pg_enum AS e
             JOIN pg_catalog.pg_type AS t ON t.oid = e.enumtypid
            WHERE t.typname = 'attendance_status') AS record_status
      `;
      expect(enums!.session_status).toEqual(["draft", "open", "submitted", "locked", "cancelled"]);
      expect(enums!.record_status).toEqual(["present", "absent", "late", "excused", "remote"]);

      const createdAt = session.createdAt.toISOString();
      const record = (status: string, minutesLate: string) =>
        `INSERT INTO app.attendance_records
           (school_id, attendance_session_id, session_created_at, student_id, status,
            minutes_late, created_at, updated_at)
         VALUES ('${school}', '${session.id}', '${createdAt}', '${fixture.students[1]!}',
           '${status}', ${minutesLate}, '${JULY}'::timestamptz, '${JULY}'::timestamptz)`;

      await expectDenied(database, record("truant", "NULL"), school);
      // minutes_late must be non-negative and only meaningful for a late student.
      await expectDenied(database, record("late", "-5"), school);
      await expectDenied(database, record("present", "10"), school);
      await expectDenied(
        database,
        `INSERT INTO app.attendance_records
           (school_id, attendance_session_id, session_created_at, student_id, status, reason,
            created_at, updated_at)
         VALUES ('${school}', '${session.id}', '${createdAt}', '${fixture.students[2]!}',
           'excused', '  whitespace padded  ', '${JULY}'::timestamptz, '${JULY}'::timestamptz)`,
        school,
      );
      await expectDenied(
        database,
        `INSERT INTO app.attendance_records
           (school_id, attendance_session_id, session_created_at, student_id, status,
            created_at, updated_at)
         VALUES ('${school}', '${session.id}', '${createdAt}', '${fixture.students[2]!}',
           'absent', '${JULY}'::timestamptz, '${JUNE}'::timestamptz)`,
        school,
      );
      await expectDenied(
        database,
        `INSERT INTO app.attendance_sessions
           (school_id, class_id, session_date, period, status, created_at, updated_at)
         VALUES ('${school}', '${fixture.classId}', '2026-07-21', 0, 'open',
           '${JULY}'::timestamptz, '${JULY}'::timestamptz)`,
        school,
      );
      await expectDenied(
        database,
        `INSERT INTO app.attendance_sessions
           (school_id, class_id, session_date, status, created_at, updated_at)
         VALUES ('${school}', '${fixture.classId}', '2026-07-22', 'finished',
           '${JULY}'::timestamptz, '${JULY}'::timestamptz)`,
        school,
      );
      await expectDenied(
        database,
        `INSERT INTO app.attendance_sessions
           (school_id, class_id, session_date, status, created_at, updated_at)
         VALUES ('${school}', '${fixture.classId}', '2026-07-23', 'open',
           '${JULY}'::timestamptz, '${JUNE}'::timestamptz)`,
        school,
      );

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        await tx.unsafe(record("late", "10"));
        await tx`
          INSERT INTO app.attendance_records
            (school_id, attendance_session_id, session_created_at, student_id, status, reason,
             created_at, updated_at)
          VALUES (${school}, ${session.id}, ${session.createdAt}, ${fixture.students[2]!},
            'excused', 'Medical appointment', ${JULY}::timestamptz, ${JULY}::timestamptz)
        `;
      });
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

integrationTest(
  "the declared indexes are used, are not duplicated, and prune partitions on created_at",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "index-school");
      const fixture = await createFixture(database, school, "IDX");
      const session = await createSession(database, fixture, {
        createdAt: JULY,
        sessionDate: "2026-07-06",
      });

      // No two indexes on the same relation cover the same columns -- the parent's partitioned index
      // manages its children, so nothing is declared twice.
      const duplicates = await database.sql<{ indrelid: string }[]>`
        SELECT i.indrelid::regclass::text AS indrelid
        FROM pg_catalog.pg_index AS i
        JOIN pg_catalog.pg_class AS c ON c.oid = i.indrelid
        JOIN pg_catalog.pg_namespace AS ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'app' AND c.relname LIKE 'attendance%'
        GROUP BY i.indrelid, i.indkey::text, i.indclass::text,
                 pg_catalog.pg_get_expr(i.indexprs, i.indrelid),
                 pg_catalog.pg_get_expr(i.indpred, i.indrelid)
        HAVING count(*) > 1
      `;
      expect(duplicates).toHaveLength(0);

      // The required leading index: (school_id, class_id, session_date).
      const sessionLookup = await explainRelations(
        database,
        school,
        `SELECT id FROM app.attendance_sessions
         WHERE school_id = '${school}' AND class_id = '${fixture.classId}'
           AND session_date = '2026-07-06'`,
      );
      const sessionIndexUsed = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        await tx.unsafe("SET LOCAL enable_seqscan = off");
        const rows = await tx.unsafe<{ "QUERY PLAN": string }[]>(
          `EXPLAIN SELECT id FROM app.attendance_sessions
             WHERE school_id = '${school}' AND class_id = '${fixture.classId}'
               AND session_date = '2026-07-06'`,
        );
        return rows.map((row) => row["QUERY PLAN"]).join("\n");
      });
      expect(sessionIndexUsed).toContain("school_id_class_id_session_dat");
      // Without a created_at predicate every monthly partition must be scanned. This is the real cost
      // of partitioning on created_at while querying by session_date, and it is not hidden.
      expect(sessionLookup.size).toBe(8);

      // Constraining created_at prunes to the single month.
      const pruned = await explainRelations(
        database,
        school,
        `SELECT id FROM app.attendance_sessions
         WHERE school_id = '${school}' AND class_id = '${fixture.classId}'
           AND created_at >= '2026-07-01+00' AND created_at < '2026-08-01+00'`,
      );
      expect([...pruned]).toEqual(["attendance_sessions_y2026m07"]);

      // The roster read for one session, and the student-history read, both on their own index.
      const rosterPlan = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        await tx.unsafe("SET LOCAL enable_seqscan = off");
        const rows = await tx.unsafe<{ "QUERY PLAN": string }[]>(
          `EXPLAIN SELECT id FROM app.attendance_records
             WHERE school_id = '${school}' AND attendance_session_id = '${session.id}'`,
        );
        return rows.map((row) => row["QUERY PLAN"]).join("\n");
      });
      expect(rosterPlan).toContain("school_id_attendance_session_id");

      const historyPruned = await explainRelations(
        database,
        school,
        `SELECT id FROM app.attendance_records
         WHERE school_id = '${school}' AND student_id = '${fixture.students[0]!}'
           AND created_at >= '2026-07-01+00' AND created_at < '2026-08-01+00'
         ORDER BY created_at DESC`,
      );
      expect([...historyPruned]).toEqual(["attendance_records_y2026m07"]);
    } finally {
      await database.cleanup();
    }
  },
  90_000,
);
