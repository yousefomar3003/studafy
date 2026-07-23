// Measures the ST-040 acceptance target: a 40-record attendance roster written through the
// partitioned parent in under 50 ms.
//
// The path measured is the one the API is expected to use, with every control left on: one
// transaction, one multi-row INSERT, transaction-local tenant GUC, forced RLS, all foreign keys, all
// check constraints, and the business-key registry trigger firing once per row. Nothing is disabled to
// make the number look better, and the session rows are created outside the timed region because
// creating the session is a separate request in the real flow.
//
// Two numbers are produced and both are printed. The database's own execution time for the batch
// (from pg_stat_statements) isolates schema cost. The end-to-end wall time includes the transaction,
// tenant context, network round-trips and insert, so its median is the acceptance measurement and must
// remain below 50 ms. CI runs this file separately to keep that host-sensitive measurement meaningful.
//
// This is a development measurement on a disposable container, not a production SLA. See the
// benchmark section of docs/database/attendance.md for the environment and the recorded numbers.
import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { ensureAttendancePartitions } from "../src/attendance-partitions";
import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const benchmarkTest = test.skipIf(!integrationEnabled || process.env.ATTENDANCE_BENCHMARK !== "1");
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");

const ROSTER_SIZE = 40;
const WARMUP_ITERATIONS = 5;
const MEASURED_ITERATIONS = 30;
const TARGET_MS = 50;

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

benchmarkTest(
  `a ${ROSTER_SIZE}-record batch insert through the partitioned parent stays under ${TARGET_MS}ms`,
  async () => {
    const database = await testDatabase();
    try {
      await runMigrationCommand("migrate", {
        env: runnerEnv(database.url, repositoryMigrations),
        log: () => undefined,
      });
      // Rows default created_at to CURRENT_TIMESTAMP, so the benchmark writes into the current real
      // month. Guarantee that partition exists rather than depending on when this suite is run.
      await ensureAttendancePartitions(0, {
        env: runnerEnv(database.url, repositoryMigrations),
        log: () => undefined,
      });

      const asApp = async <T>(run: (tx: TransactionSql) => Promise<T>): Promise<T> => {
        let result: T | undefined;
        await database.sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE studafy_app");
          result = await run(tx);
        });
        return result as T;
      };

      const [refs] = await database.sql<{ country: string; currency: string }[]>`
        SELECT
          (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
          (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
      `;
      const school = await database.sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
          VALUES ('bench', 'bench', 'bench@admin.local', 'bench@admin.local', ${refs!.country}, ${refs!.currency}) RETURNING id
        `;
        return row!.id;
      });

      const fixture = await asApp(async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [teacherUser] = await tx<{ id: string }[]>`
          INSERT INTO app.users (school_id, email, normalized_email, status)
          VALUES (${school}, 'teacher@bench.test', 'teacher@bench.test', 'active') RETURNING id
        `;
        const [teacher] = await tx<{ id: string }[]>`
          INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
          VALUES (${school}, ${teacherUser!.id}, 'EMP-BENCH', 'active') RETURNING id
        `;
        const [year] = await tx<{ id: string }[]>`
          INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
          VALUES (${school}, 'AY-BENCH', 'Year', '2026-08-01', '2027-06-30', 'planned') RETURNING id
        `;
        const [term] = await tx<{ id: string }[]>`
          INSERT INTO app.terms
            (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
          VALUES (${school}, ${year!.id}, 'T-BENCH', 'Term', 1, '2026-08-15', '2026-12-20', 'planned')
          RETURNING id
        `;
        const [subject] = await tx<{ id: string }[]>`
          INSERT INTO app.subjects (school_id, code, name, status)
          VALUES (${school}, 'SUB-BENCH', 'Mathematics', 'active') RETURNING id
        `;
        const [course] = await tx<{ id: string }[]>`
          INSERT INTO app.courses (school_id, subject_id, code, name, status)
          VALUES (${school}, ${subject!.id}, 'CRS-BENCH', 'Algebra', 'active') RETURNING id
        `;
        const [room] = await tx<{ id: string }[]>`
          INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building)
          VALUES (${school}, 'ROOM-BENCH', 'Room', 'physical', 40, 'Main') RETURNING id
        `;
        const [classRow] = await tx<{ id: string }[]>`
          INSERT INTO app.classes
            (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id,
             code, capacity, status)
          VALUES (${school}, ${course!.id}, ${year!.id}, ${term!.id}, ${teacher!.id}, ${room!.id},
            'CLASS-BENCH', 40, 'active') RETURNING id
        `;
        const students = await tx<{ id: string }[]>`
          WITH created_users AS (
            INSERT INTO app.users (school_id, email, normalized_email, status)
            SELECT ${school}::uuid,
                   format('student-%s@bench.test', ordinal),
                   format('student-%s@bench.test', ordinal),
                   'active'
            FROM generate_series(1, ${ROSTER_SIZE}::integer) AS ordinal
            RETURNING id, normalized_email
          )
          INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
          SELECT ${school}::uuid, id, normalized_email, 'First', 'Student'
          FROM created_users
          RETURNING id
        `;
        await tx`
          INSERT INTO app.enrollments (school_id, class_id, student_id)
          SELECT ${school}::uuid, ${classRow!.id}::uuid, student_id
          FROM unnest(${students.map((row) => row.id)}::uuid[]) AS student_id
        `;
        return {
          classId: classRow!.id,
          teacherUser: teacherUser!.id,
          students: students.map((row) => row.id),
        };
      });

      expect(fixture.students.length).toBe(ROSTER_SIZE);

      // One session per iteration. Created up front and outside the timed region: taking attendance is
      // "open the session, then submit the roster", and only the roster write is the batch path.
      // This is the real API shape: create the session, keep its (id, created_at), then submit the
      // roster referencing both. It only works because created_at is timestamptz(3) -- the driver
      // transports a bound timestamp at millisecond precision, so a microsecond-precision created_at
      // could never be matched back to its session by the composite foreign key. See the header of
      // 000012 and docs/database/attendance.md.
      const total = WARMUP_ITERATIONS + MEASURED_ITERATIONS;
      const sessions = await asApp(async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        return tx<{ id: string; created_at: Date }[]>`
          INSERT INTO app.attendance_sessions
            (school_id, class_id, session_date, period, status, taken_by_user_id)
          SELECT ${school}::uuid, ${fixture.classId}::uuid, '2026-09-14'::date, ordinal::smallint,
                 'open', ${fixture.teacherUser}::uuid
          FROM generate_series(1, ${total}::integer) AS ordinal
          RETURNING id, created_at
        `;
      });
      expect(sessions.length).toBe(total);

      const runBatch = async (session: { id: string; created_at: Date }): Promise<number> => {
        const started = performance.now();
        await database.sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE studafy_app");
          await tx`SELECT set_config('app.school_id', ${school}, true)`;
          await tx`
            INSERT INTO app.attendance_records
              (school_id, attendance_session_id, session_created_at, student_id, status,
               recorded_by_user_id)
            SELECT ${school}::uuid, ${session.id}::uuid, ${session.created_at}::timestamptz,
                   student_id, 'present', ${fixture.teacherUser}::uuid
            FROM unnest(${fixture.students}::uuid[]) AS student_id
          `;
        });
        return performance.now() - started;
      };

      for (const session of sessions.slice(0, WARMUP_ITERATIONS)) await runBatch(session);

      // Reset the statement statistics for this database only (0 means "any" for user and query), so
      // what pg_stat_statements reports below is exactly the measured iterations and nothing else.
      await database.sql`
        SELECT pg_stat_statements_reset(
          0, (SELECT oid FROM pg_database WHERE datname = current_database()), 0
        )
      `;

      const samples: number[] = [];
      for (const session of sessions.slice(WARMUP_ITERATIONS))
        samples.push(await runBatch(session));

      const sorted = [...samples].sort((a, b) => a - b);
      const round = (value: number) => Math.round(value * 100) / 100;
      const clientStats = {
        iterations: sorted.length,
        min: sorted[0]!,
        median: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted.at(-1)!,
      };

      // The database's own execution time for the same statements. This is the cost the schema
      // controls -- constraints, the registry trigger, RLS, index maintenance, partition routing.
      // The client-side figure above additionally contains five network round-trips per iteration
      // (BEGIN, SET LOCAL ROLE, set_config, INSERT, COMMIT), which on a developer machine can exceed
      // the database work several times over and which vary with whatever else the machine is doing.
      // Both are recorded in docs/database/attendance.md. Server time diagnoses schema regressions;
      // the end-to-end median is the ticket's user-visible development acceptance measurement.
      const [server] = await database.sql<
        { calls: string; mean_ms: number; min_ms: number; max_ms: number }[]
      >`
        SELECT calls::text AS calls,
               mean_exec_time AS mean_ms,
               min_exec_time AS min_ms,
               max_exec_time AS max_ms
        FROM pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND query ILIKE 'INSERT INTO app.attendance_records%'
      `;

      console.log(
        `attendance batch insert (${ROSTER_SIZE} records x ${clientStats.iterations} iterations)\n` +
          `  database: mean ${round(server!.mean_ms)}ms, ` +
          `min ${round(server!.min_ms)}ms, max ${round(server!.max_ms)}ms ` +
          `over ${server!.calls} statements\n` +
          `  end-to-end: min ${round(clientStats.min)}ms, median ${round(clientStats.median)}ms, ` +
          `p95 ${round(clientStats.p95)}ms, max ${round(clientStats.max)}ms`,
      );

      // Every row must have landed in the current month's partition, through the parent.
      const [routing] = await database.sql<{ partitions: string; rows: string }[]>`
        SELECT count(DISTINCT tableoid)::text AS partitions, count(*)::text AS rows
        FROM app.attendance_records
      `;
      expect(routing!.partitions).toBe("1");
      expect(routing!.rows).toBe(String(total * ROSTER_SIZE));

      // The measured statements are the ones we think they are: one multi-row INSERT per iteration,
      // not 40 single-row inserts.
      expect(server!.calls).toBe(String(MEASURED_ITERATIONS));
      expect(server!.mean_ms).toBeLessThan(TARGET_MS);
      expect(clientStats.median).toBeLessThan(TARGET_MS);
    } finally {
      await database.cleanup();
    }
  },
  180_000,
);
