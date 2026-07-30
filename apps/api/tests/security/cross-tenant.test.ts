import { resolve } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { auditRlsCoverage, formatRlsCoverageReport } from "../../../../db/policies/rls-coverage";
import { runMigrationCommand } from "../../../../packages/db/src/runner";
import { integrationEnabled, runnerEnv, testDatabase } from "../../../../packages/db/tests/helpers";
import { withTenantTransaction } from "../../src/database";

import { formatProbeDiagnostic, inspectPlan, quoteIdentifier } from "./probe-support";

import type { ProbeDiagnostic } from "./probe-support";
import type { CatalogClient } from "../../../../db/policies/rls-coverage";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../../db/migrations");
const PROBE_BUDGET_MS = 1000;
const CONCURRENCY = 32;
const POOL_SIZE = 4;
// Dedicated multi-connection pool so the write/mutation/insert probes run concurrently instead of
// one blocking transaction at a time; opened once in beforeAll (outside the gated timing window).
const PROBE_POOL_SIZE = 16;
const JULY = "2026-07-15 12:00:00+00";

type TestDatabase = Awaited<ReturnType<typeof testDatabase>>;

interface TenantFixture {
  school: string;
  user: string;
  student: string;
  secondaryStudent: string;
  classId: string;
  attendanceSession: string;
  attendanceSessionCreatedAt: Date;
  attendanceRecord: string;
  notification: string;
  device: string;
  auditLog: string;
  auditCreatedAt: Date;
  material: string;
  materialChunk: string;
  conversation: string;
  message: string;
  usageMeter: string;
  secondarySubscription: string;
  outboxEvent: string;
  installmentCache: string;
  reconciliationLog: string;
}

interface SeededFixture {
  a: TenantFixture;
  b: TenantFixture;
  setupMs: number;
}

interface ProbeRelation {
  table: string;
  predicate: string;
  primaryKey: string;
}

interface TenantRelation {
  name: string;
  rows: number;
  // Extra predicate that makes the table's school_id-leading tenant index usable by the forced
  // index-plan probe. Empty for tables whose school_id index is non-partial (the common case);
  // for a table indexed only through a partial index (e.g. app.outbox_events'
  // `(school_id, id) WHERE relayed_at IS NULL`), this carries that index's partial predicate so the
  // probe queries along the access path the schema actually indexes rather than a whole-table scan.
  extraPredicate: string;
}

let database: TestDatabase | undefined;
let fixture: SeededFixture | undefined;
let probePool: ReturnType<typeof postgres> | undefined;

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

async function asAdmin<T>(
  sql: TestDatabase["sql"],
  school: string,
  run: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await sql.begin(async (transaction) => {
    await transaction.unsafe("SET LOCAL ROLE studafy_admin");
    await transaction`SELECT set_config('app.school_id', ${school}, true)`;
    result = await run(transaction);
  });
  return result as T;
}

async function createSchools(sql: TestDatabase["sql"]): Promise<[string, string]> {
  const [references] = await sql<{ country: string; currency: string }[]>`
    SELECT
      (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
      (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
  `;
  const rows = await asAdmin(
    sql,
    crypto.randomUUID(),
    (transaction) =>
      transaction<{ id: string; slug: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES
        ('st051-school-a', 'ST-051 School A', 'st051-school-a@admin.local', 'st051-school-a@admin.local', ${references!.country}, ${references!.currency}),
        ('st051-school-b', 'ST-051 School B', 'st051-school-b@admin.local', 'st051-school-b@admin.local', ${references!.country}, ${references!.currency})
      RETURNING id, slug
    `,
  );
  return [
    rows.find((row) => row.slug === "st051-school-a")!.id,
    rows.find((row) => row.slug === "st051-school-b")!.id,
  ];
}

async function seedTenant(
  sql: TestDatabase["sql"],
  school: string,
  suffix: "a" | "b",
): Promise<TenantFixture> {
  return sql.begin(async (transaction) => {
    await transaction.unsafe("SET LOCAL ROLE studafy_app");
    await transaction`SELECT set_config('app.school_id', ${school}, true)`;

    const email = `st051-${suffix}@example.test`;
    const [user] = await transaction<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${school}, ${email}, ${email}, 'active') RETURNING id
    `;
    await transaction`SELECT set_config('app.user_id', ${user!.id}, true)`;
    // ST-085: the academic tables now carry role_scope_visibility restrictive policies. This probe's
    // principal is a plain user; granting it an admin role in its own school keeps it able to read the
    // rows it seeds, so the forced-index-plan sweep still exercises real access paths rather than
    // empty results. It does not weaken the cross-tenant assertions -- admin scope is school-local.
    await transaction`
      INSERT INTO app.user_roles (school_id, user_id, role)
      VALUES (${school}, ${user!.id}, 'ORG_ADMIN')
    `;
    const studentEmail = `st051-student-${suffix}@example.test`;
    const [studentUser] = await transaction<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${school}, ${studentEmail}, ${studentEmail}, 'active') RETURNING id
    `;
    const [student] = await transaction<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (${school}, ${studentUser!.id}, ${`ST051-${suffix.toUpperCase()}`}, 'Security', 'Probe',
        'enrolled') RETURNING id
    `;
    const secondaryEmail = `st051-secondary-${suffix}@example.test`;
    const [secondaryUser] = await transaction<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${school}, ${secondaryEmail}, ${secondaryEmail}, 'active') RETURNING id
    `;
    const [secondaryStudent] = await transaction<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (${school}, ${secondaryUser!.id}, ${`ST051-SECONDARY-${suffix.toUpperCase()}`},
        'Secondary', 'Probe', 'enrolled') RETURNING id
    `;
    const [teacher] = await transaction<{ id: string }[]>`
      INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
      VALUES (${school}, ${user!.id}, ${`EMP-ST051-${suffix.toUpperCase()}`}, 'active') RETURNING id
    `;
    const [year] = await transaction<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${school}, ${`AY-ST051-${suffix}`}, 'ST-051 Year', '2026-01-01', '2026-12-31',
        'planned') RETURNING id
    `;
    const [term] = await transaction<{ id: string }[]>`
      INSERT INTO app.terms
        (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
      VALUES (${school}, ${year!.id}, ${`TERM-ST051-${suffix}`}, 'ST-051 Term', 1,
        '2026-01-01', '2026-06-30', 'planned') RETURNING id
    `;
    const [subject] = await transaction<{ id: string }[]>`
      INSERT INTO app.subjects (school_id, code, name, status)
      VALUES (${school}, ${`SUB-ST051-${suffix}`}, 'Security', 'active') RETURNING id
    `;
    const [course] = await transaction<{ id: string }[]>`
      INSERT INTO app.courses (school_id, subject_id, code, name, status)
      VALUES (${school}, ${subject!.id}, ${`COURSE-ST051-${suffix}`}, 'Isolation', 'active')
      RETURNING id
    `;
    const [room] = await transaction<{ id: string }[]>`
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building)
      VALUES (${school}, ${`ROOM-ST051-${suffix}`}, 'Probe Room', 'physical', 32, 'Security')
      RETURNING id
    `;
    const [classRow] = await transaction<{ id: string }[]>`
      INSERT INTO app.classes
        (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code,
         capacity, status)
      VALUES (${school}, ${course!.id}, ${year!.id}, ${term!.id}, ${teacher!.id}, ${room!.id},
        ${`CLASS-ST051-${suffix}`}, 32, 'active') RETURNING id
    `;
    await transaction`
      INSERT INTO app.enrollments (school_id, class_id, student_id)
      VALUES (${school}, ${classRow!.id}, ${student!.id})
    `;
    const [material] = await transaction<{ id: string }[]>`
      INSERT INTO app.materials
        (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title, storage_key,
         original_file_name, mime_type, size_bytes)
      VALUES (${school}, ${classRow!.id}, ${user!.id}, ${user!.id}, 'Probe Material',
        ${`permanent/${school}/probe/material-${suffix}`}, 'probe.pdf', 'application/pdf', 128)
      RETURNING id
    `;
    const [chunk] = await transaction<{ id: string }[]>`
      INSERT INTO app.material_chunks
        (school_id, material_id, chunk_index, content, embedding, embedding_model)
      VALUES (${school}, ${material!.id}, 0, ${`tenant ${suffix} confidential content`},
        array_fill(0::real, ARRAY[1536])::public.vector, 'text-embedding-3-small') RETURNING id
    `;
    const [session] = await transaction<{ id: string; created_at: Date }[]>`
      INSERT INTO app.attendance_sessions
        (school_id, class_id, session_date, status, taken_by_user_id, created_at, updated_at)
      VALUES (${school}, ${classRow!.id}, '2026-07-15', 'open', ${user!.id},
        ${JULY}::timestamptz, ${JULY}::timestamptz) RETURNING id, created_at
    `;
    const [record] = await transaction<{ id: string }[]>`
      INSERT INTO app.attendance_records
        (school_id, attendance_session_id, session_created_at, student_id, status,
         recorded_by_user_id, created_at, updated_at)
      VALUES (${school}, ${session!.id}, ${session!.created_at}, ${student!.id}, 'present',
        ${user!.id}, ${JULY}::timestamptz, ${JULY}::timestamptz) RETURNING id
    `;
    const [notification] = await transaction<{ id: string }[]>`
      INSERT INTO app.notifications (school_id, user_id, notification_type, title, body)
      VALUES (${school}, ${user!.id}, 'SUPPORT_MESSAGE', 'Security probe', 'Tenant-local body')
      RETURNING id
    `;
    const [device] = await transaction<{ id: string }[]>`
      INSERT INTO app.user_devices (school_id, user_id, fcm_token, platform)
      VALUES (${school}, ${user!.id}, ${`st051-token-${suffix}`}, 'web') RETURNING id
    `;
    const [audit] = await transaction<{ id: string; created_at: Date }[]>`
      INSERT INTO app.audit_logs
        (school_id, actor_id, action, target_table, target_id, new_values, created_at)
      VALUES (${school}, ${user!.id}, 'insert', 'users', ${user!.id}, '{"probe":true}'::jsonb,
        ${JULY}::timestamptz) RETURNING id, created_at
    `;
    const [subscription] = await transaction<{ id: string }[]>`
      INSERT INTO app.ai_subscriptions
        (school_id, student_id, status, current_period_start, current_period_end)
      VALUES (${school}, ${student!.id}, 'active', CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '30 days') RETURNING id
    `;
    const [secondarySubscription] = await transaction<{ id: string }[]>`
      INSERT INTO app.ai_subscriptions
        (school_id, student_id, status, current_period_start, current_period_end)
      VALUES (${school}, ${secondaryStudent!.id}, 'active', CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '30 days') RETURNING id
    `;
    const [conversation] = await transaction<{ id: string }[]>`
      INSERT INTO app.ai_conversations (school_id, student_id, model)
      VALUES (${school}, ${student!.id}, 'security-probe') RETURNING id
    `;
    const [message] = await transaction<{ id: string }[]>`
      INSERT INTO app.ai_messages
        (school_id, conversation_id, question, answer, prompt_tokens, completion_tokens,
         total_tokens, expires_at)
      VALUES (${school}, ${conversation!.id}, 'tenant?', 'isolated', 2, 1, 3,
        CURRENT_TIMESTAMP + INTERVAL '1 day') RETURNING id
    `;
    await transaction`
      INSERT INTO app.ai_message_citations
        (school_id, ai_message_id, material_chunk_id, citation_order)
      VALUES (${school}, ${message!.id}, ${chunk!.id}, 1)
    `;
    const [usage] = await transaction<{ id: string }[]>`
      INSERT INTO app.ai_usage_meters (school_id, student_id, ai_subscription_id, total_tokens)
      VALUES (${school}, ${student!.id}, ${subscription!.id}, 3) RETURNING id
    `;
    const [outbox] = await transaction<{ id: string }[]>`
      INSERT INTO app.outbox_events (school_id, event_name, payload)
      VALUES (${school}, 'security.probed', '{"probe":true}'::jsonb) RETURNING id::text AS id
    `;
    const [currencyRow] = await transaction<{ id: string }[]>`
      SELECT id FROM app.currencies WHERE code = 'JOD' LIMIT 1
    `;
    const [installment] = await transaction<{ id: string }[]>`
      INSERT INTO app.installment_cache
        (school_id, erpnext_fee_schedule_id, student_id, due_date, total_amount_minor,
         paid_amount_minor, outstanding_amount_minor, currency_id, status, erpnext_payload,
         synced_at)
      VALUES (${school}, ${`FSCHED-ST051-${suffix}`}, ${student!.id}, '2026-07-15', 10000,
         10000, 0, ${currencyRow!.id}, 'paid', '{}'::jsonb,
         CURRENT_TIMESTAMP) RETURNING id
    `;
    const [reconLog] = await transaction<{ id: string }[]>`
      INSERT INTO app.finance_reconciliation_logs
        (school_id, job_run_at, records_checked, drift_detected_count, auto_healed_count,
         unresolved_divergences, status)
      VALUES (${school}, CURRENT_TIMESTAMP, 0, 0, 0, '[]'::jsonb, 'success')
      RETURNING id
    `;

    return {
      school,
      user: user!.id,
      student: student!.id,
      secondaryStudent: secondaryStudent!.id,
      classId: classRow!.id,
      attendanceSession: session!.id,
      attendanceSessionCreatedAt: session!.created_at,
      attendanceRecord: record!.id,
      notification: notification!.id,
      device: device!.id,
      auditLog: audit!.id,
      auditCreatedAt: audit!.created_at,
      material: material!.id,
      materialChunk: chunk!.id,
      conversation: conversation!.id,
      message: message!.id,
      usageMeter: usage!.id,
      secondarySubscription: secondarySubscription!.id,
      outboxEvent: outbox!.id,
      installmentCache: installment!.id,
      reconciliationLog: reconLog!.id,
    };
  });
}

function probeRelations(value: TenantFixture): ProbeRelation[] {
  const uuid = (column: string, id: string): string => `${column} = '${id}'::uuid`;
  return [
    { table: "users", predicate: uuid("id", value.user), primaryKey: value.user },
    { table: "students", predicate: uuid("id", value.student), primaryKey: value.student },
    {
      table: "attendance_sessions",
      predicate: uuid("id", value.attendanceSession),
      primaryKey: value.attendanceSession,
    },
    {
      table: "attendance_records",
      predicate: uuid("id", value.attendanceRecord),
      primaryKey: value.attendanceRecord,
    },
    {
      table: "notifications",
      predicate: uuid("id", value.notification),
      primaryKey: value.notification,
    },
    { table: "user_devices", predicate: uuid("id", value.device), primaryKey: value.device },
    { table: "audit_logs", predicate: uuid("id", value.auditLog), primaryKey: value.auditLog },
    { table: "materials", predicate: uuid("id", value.material), primaryKey: value.material },
    {
      table: "material_chunks",
      predicate: uuid("id", value.materialChunk),
      primaryKey: value.materialChunk,
    },
    {
      table: "ai_conversations",
      predicate: uuid("id", value.conversation),
      primaryKey: value.conversation,
    },
    { table: "ai_messages", predicate: uuid("id", value.message), primaryKey: value.message },
    {
      table: "ai_usage_meters",
      predicate: uuid("id", value.usageMeter),
      primaryKey: value.usageMeter,
    },
    {
      table: "ai_message_citations",
      predicate:
        `school_id = '${value.school}'::uuid AND ` +
        `ai_message_id = '${value.message}'::uuid AND citation_order = 1`,
      primaryKey: `${value.school}/${value.message}/1`,
    },
    {
      table: "outbox_events",
      predicate: `id = ${value.outboxEvent}::bigint`,
      primaryKey: value.outboxEvent,
    },
    {
      table: "installment_cache",
      predicate: uuid("id", value.installmentCache),
      primaryKey: value.installmentCache,
    },
    {
      table: "finance_reconciliation_logs",
      predicate: uuid("id", value.reconciliationLog),
      primaryKey: value.reconciliationLog,
    },
  ];
}

async function assertCrossTenantCrud(value: SeededFixture): Promise<void> {
  const relations = probeRelations(value.b);
  const tenantA = { schoolId: value.a.school, userId: value.a.user };
  const diagnosticFor = (relation: ProbeRelation): ProbeDiagnostic => ({
    operation: "cross-tenant CRUD",
    relation: `app.${quoteIdentifier(relation.table)}`,
    primaryKey: relation.primaryKey,
    expectedTenant: value.a.school,
    observedTenant: value.b.school,
  });

  // Reads never raise -- tenant A simply sees zero of tenant B's rows -- so pipeline every relation's
  // read through one transaction instead of a BEGIN/SET/COMMIT round-trip per relation.
  const reads = await withTenantTransaction(database!.sql, tenantA, (transaction) =>
    Promise.all(
      relations.map((relation) =>
        transaction.unsafe(
          `SELECT 1 FROM app.${quoteIdentifier(relation.table)} WHERE ${relation.predicate}`,
        ),
      ),
    ),
  );
  relations.forEach((relation, index) => {
    const rowCount = reads[index]!.length;
    expect(
      rowCount,
      formatProbeDiagnostic({ ...diagnosticFor(relation), operation: "read", rowCount }),
    ).toBe(0);
  });

  // Writes either affect zero rows or are denied outright; keep each in its own transaction so a
  // denial cannot poison a sibling, but spread them across the pool to run concurrently.
  await Promise.all(
    relations.map(async (relation) => {
      const table = `app.${quoteIdentifier(relation.table)}`;
      const diagnostic = diagnosticFor(relation);
      try {
        const update = await withTenantTransaction(probePool!, tenantA, (transaction) =>
          transaction.unsafe(
            `UPDATE ${table} SET school_id = school_id WHERE ${relation.predicate}`,
          ),
        );
        expect(
          update.count,
          formatProbeDiagnostic({ ...diagnostic, operation: "update", rowCount: update.count }),
        ).toBe(0);
      } catch (error) {
        expect(
          ["42501"],
          formatProbeDiagnostic({ ...diagnostic, operation: "update", sqlState: errorCode(error) }),
        ).toContain(errorCode(error));
      }

      try {
        const deleted = await withTenantTransaction(probePool!, tenantA, (transaction) =>
          transaction.unsafe(`DELETE FROM ${table} WHERE ${relation.predicate}`),
        );
        expect(
          deleted.count,
          formatProbeDiagnostic({ ...diagnostic, operation: "delete", rowCount: deleted.count }),
        ).toBe(0);
      } catch (error) {
        expect(
          ["42501"],
          formatProbeDiagnostic({ ...diagnostic, operation: "delete", sqlState: errorCode(error) }),
        ).toContain(errorCode(error));
      }
    }),
  );

  // Ownership is structurally immutable: even a direct, non-RLS UPDATE flipping school_id must be
  // rejected by the trigger. Run the whole battery concurrently across the pool.
  await Promise.all(
    probeRelations(value.a).map(async (relation) => {
      const table = `app.${quoteIdentifier(relation.table)}`;
      try {
        await probePool!.unsafe(
          `UPDATE ${table} SET school_id = $1::uuid WHERE ${relation.predicate}`,
          [value.b.school],
        );
        throw new Error(`tenant ownership mutation unexpectedly succeeded for ${table}`);
      } catch (error) {
        expect(
          errorCode(error),
          formatProbeDiagnostic({
            operation: "tenant mutation",
            relation: table,
            primaryKey: relation.primaryKey,
            expectedTenant: value.a.school,
            observedTenant: value.b.school,
            sqlState: errorCode(error),
          }),
        ).toBe("42501");
      }
    }),
  );

  await Promise.all(
    [
      `INSERT INTO app.users (school_id, email, normalized_email, status) VALUES ('${value.b.school}', 'st051-cross-user@example.test', 'st051-cross-user@example.test', 'active')`,
      `INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status) VALUES ('${value.b.school}', '${value.b.user}', 'ST051-CROSS', 'Cross', 'Tenant', 'enrolled')`,
      `INSERT INTO app.attendance_sessions (school_id, class_id, session_date, status, taken_by_user_id, created_at, updated_at) VALUES ('${value.b.school}', '${value.b.classId}', '2026-07-16', 'open', '${value.b.user}', '${JULY}'::timestamptz, '${JULY}'::timestamptz)`,
      `INSERT INTO app.attendance_records (school_id, attendance_session_id, session_created_at, student_id, status, recorded_by_user_id, created_at, updated_at) VALUES ('${value.b.school}', '${value.b.attendanceSession}', '${value.b.attendanceSessionCreatedAt.toISOString()}', '${value.b.secondaryStudent}', 'present', '${value.b.user}', '${JULY}'::timestamptz, '${JULY}'::timestamptz)`,
      `INSERT INTO app.outbox_events (school_id, event_name, payload) VALUES ('${value.b.school}', 'security.attacked', '{}'::jsonb)`,
      `INSERT INTO app.notifications (school_id, user_id, notification_type, title, body) VALUES ('${value.b.school}', '${value.b.user}', 'SUPPORT_MESSAGE', 'cross', 'cross')`,
      `INSERT INTO app.user_devices (school_id, user_id, fcm_token, platform) VALUES ('${value.b.school}', '${value.b.user}', 'st051-cross-token', 'web')`,
      `INSERT INTO app.audit_logs (school_id, actor_id, action, target_table, target_id, new_values, created_at) VALUES ('${value.b.school}', '${value.b.user}', 'insert', 'users', '${value.b.user}', '{"cross":true}'::jsonb, '${JULY}'::timestamptz)`,
      `INSERT INTO app.materials (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title, storage_key, original_file_name, mime_type, size_bytes) VALUES ('${value.b.school}', '${value.b.classId}', '${value.b.user}', '${value.b.user}', 'Cross material', 'permanent/${value.b.school}/probe/cross-material', 'cross.pdf', 'application/pdf', 128)`,
      `INSERT INTO app.material_chunks (school_id, material_id, chunk_index, content, embedding, embedding_model) VALUES ('${value.b.school}', '${value.b.material}', 1, 'cross chunk', array_fill(0::real, ARRAY[1536])::public.vector, 'text-embedding-3-small')`,
      `INSERT INTO app.ai_conversations (school_id, student_id, model) VALUES ('${value.b.school}', '${value.b.student}', 'cross')`,
      `INSERT INTO app.ai_messages (school_id, conversation_id, question, answer, prompt_tokens, completion_tokens, total_tokens, expires_at) VALUES ('${value.b.school}', '${value.b.conversation}', 'cross?', 'blocked', 1, 1, 2, CURRENT_TIMESTAMP + INTERVAL '1 day')`,
      `INSERT INTO app.ai_message_citations (school_id, ai_message_id, material_chunk_id, citation_order) VALUES ('${value.b.school}', '${value.b.message}', '${value.b.materialChunk}', 2)`,
      `INSERT INTO app.ai_usage_meters (school_id, student_id, ai_subscription_id, total_tokens) VALUES ('${value.b.school}', '${value.b.secondaryStudent}', '${value.b.secondarySubscription}', 1)`,
      `INSERT INTO app.installment_cache (school_id, erpnext_fee_schedule_id, student_id, due_date, total_amount_minor, paid_amount_minor, outstanding_amount_minor, currency_id, status, erpnext_payload, synced_at) VALUES ('${value.b.school}', 'FSCHED-CROSS', '${value.b.student}', '2026-07-15', 10000, 0, 10000, (SELECT id FROM app.currencies WHERE code = 'JOD' LIMIT 1), 'pending', '{}'::jsonb, CURRENT_TIMESTAMP)`,
      `INSERT INTO app.finance_reconciliation_logs (school_id, job_run_at, records_checked, drift_detected_count, auto_healed_count, unresolved_divergences, status) VALUES ('${value.b.school}', CURRENT_TIMESTAMP, 0, 0, 0, '[]'::jsonb, 'success')`,
    ].map(async (statement) => {
      try {
        await withTenantTransaction(probePool!, tenantA, (transaction) =>
          transaction.unsafe(statement),
        );
        throw new Error("cross-tenant insert unexpectedly succeeded");
      } catch (error) {
        expect(errorCode(error)).toBe("42501");
      }
    }),
  );
}

async function assertNormalizationAttack(value: SeededFixture): Promise<void> {
  try {
    await database!.sql`
      INSERT INTO app.attendance_records
        (school_id, attendance_session_id, session_created_at, student_id, status,
         recorded_by_user_id, created_at, updated_at)
      VALUES (${value.a.school}, ${value.b.attendanceSession}, ${value.b.attendanceSessionCreatedAt},
        ${value.a.student}, 'present', ${value.a.user}, ${JULY}::timestamptz,
        ${JULY}::timestamptz)
    `;
    throw new Error("cross-school attendance relationship unexpectedly succeeded");
  } catch (error) {
    expect(errorCode(error)).toBe("23503");
  }
}

async function tenantRelations(): Promise<TenantRelation[]> {
  return database!.sql<TenantRelation[]>`
    SELECT
      c.relname AS name,
      greatest(c.reltuples, 0)::integer AS rows,
      COALESCE(tenant_index.predicate, '') AS "extraPredicate"
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute AS a
      ON a.attrelid = c.oid AND a.attname = 'school_id'
     AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN LATERAL (
      -- The school_id-leading index the planner can drive for a tenant scan, preferring a
      -- non-partial one; its partial predicate (empty when non-partial) lets the probe match the
      -- index's WHERE so a legitimately partial-indexed table is not misread as a seq-scan fallback.
      SELECT COALESCE(pg_catalog.pg_get_expr(i.indpred, i.indrelid), '') AS predicate
      FROM pg_catalog.pg_index AS i
      WHERE i.indrelid = c.oid
        AND i.indisvalid AND i.indisready
        AND i.indkey[0] = a.attnum
      ORDER BY (i.indpred IS NULL) DESC
      LIMIT 1
    ) AS tenant_index ON true
    WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
    ORDER BY c.relname
  `;
}

function tenantProbeQuery(relation: TenantRelation): string {
  const scope = relation.extraPredicate ? ` WHERE ${relation.extraPredicate}` : "";
  return `SELECT 1 FROM app.${quoteIdentifier(relation.name)}${scope} LIMIT 1`;
}

async function assertIndexPlans(value: SeededFixture): Promise<void> {
  const relations = await tenantRelations();
  expect(relations.length).toBeGreaterThan(70);
  await withTenantTransaction(
    database!.sql,
    { schoolId: value.a.school, userId: value.a.user },
    async (transaction) => {
      await transaction.unsafe("SET LOCAL enable_seqscan = off");
      // Pipeline every relation's EXPLAIN on the one transaction connection rather than paying a
      // serial round-trip each; the forced enable_seqscan=off still applies to all of them.
      const plans = await Promise.all(
        relations.map((relation) =>
          transaction.unsafe<{ "QUERY PLAN": [{ Plan: Parameters<typeof inspectPlan>[0] }] }[]>(
            `EXPLAIN (FORMAT JSON) ${tenantProbeQuery(relation)}`,
          ),
        ),
      );
      relations.forEach((relation, index) => {
        const root = plans[index]?.[0]?.["QUERY PLAN"]?.[0]?.Plan;
        if (!root) throw new Error(`EXPLAIN returned no plan for app.${relation.name}`);
        const inspection = inspectPlan(root);
        const diagnostic: ProbeDiagnostic = {
          operation: "forced index plan",
          relation: `app.${relation.name}`,
          primaryKey: "n/a",
          expectedTenant: value.a.school,
          plan: root,
        };
        expect(inspection.sequentialRelations, formatProbeDiagnostic(diagnostic)).toEqual([]);
        expect(
          inspection.nodeTypes.some((type) =>
            ["Index Scan", "Index Only Scan", "Bitmap Index Scan"].includes(type),
          ),
          formatProbeDiagnostic(diagnostic),
        ).toBe(true);
      });
    },
  );

  const largeRelations = relations.filter((relation) => relation.rows >= 32);
  await withTenantTransaction(
    database!.sql,
    { schoolId: value.a.school, userId: value.a.user },
    async (transaction) => {
      const plans = await Promise.all(
        largeRelations.map((relation) =>
          transaction.unsafe<{ "QUERY PLAN": [{ Plan: Parameters<typeof inspectPlan>[0] }] }[]>(
            `EXPLAIN (FORMAT JSON) ${tenantProbeQuery(relation)}`,
          ),
        ),
      );
      largeRelations.forEach((relation, index) => {
        const root = plans[index]?.[0]?.["QUERY PLAN"]?.[0]?.Plan;
        if (!root) throw new Error(`EXPLAIN returned no natural plan for app.${relation.name}`);
        expect(
          inspectPlan(root).sequentialRelations,
          formatProbeDiagnostic({
            operation: "natural index plan",
            relation: `app.${relation.name}`,
            primaryKey: "n/a",
            expectedTenant: value.a.school,
            plan: root,
          }),
        ).toEqual([]);
      });
    },
  );
}

async function assertPoolIsolation(value: SeededFixture): Promise<void> {
  const pooled = postgres(database!.url, { max: POOL_SIZE, ssl: false, prepare: false });
  try {
    const reserved = await Promise.all(Array.from({ length: POOL_SIZE }, () => pooled.reserve()));
    const contaminatedPids = new Set<number>();
    for (const connection of reserved) {
      await connection`SELECT set_config('app.school_id', ${value.a.school}, false)`;
      const [backend] = await connection<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      contaminatedPids.add(backend!.pid);
    }
    for (const connection of reserved) connection.release();

    const observations = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, iteration) =>
        withTenantTransaction(
          pooled,
          { schoolId: value.b.school, userId: value.b.user },
          async (transaction) => {
            const [state] = await transaction<
              { school: string; pid: number; tenant_a_rows: string; tenant_b_rows: string }[]
            >`
              SELECT current_setting('app.school_id') AS school,
                pg_backend_pid() AS pid,
                (SELECT count(*)::text FROM app.outbox_events WHERE school_id = ${value.a.school})
                  AS tenant_a_rows,
                (SELECT count(*)::text FROM app.outbox_events WHERE school_id = ${value.b.school})
                  AS tenant_b_rows
            `;
            return { iteration, ...state! };
          },
        ),
      ),
    );

    for (const observation of observations) {
      const diagnostic = formatProbeDiagnostic({
        operation: `pool reuse iteration ${observation.iteration}`,
        relation: "app.outbox_events",
        primaryKey: value.b.outboxEvent,
        expectedTenant: value.b.school,
        observedTenant: observation.school,
        backendPid: observation.pid,
        rowCount: Number(observation.tenant_a_rows),
      });
      expect(contaminatedPids.has(observation.pid), diagnostic).toBe(true);
      expect(observation.school, diagnostic).toBe(value.b.school);
      expect(observation.tenant_a_rows, diagnostic).toBe("0");
      expect(observation.tenant_b_rows, diagnostic).toBe("1");
    }

    try {
      await withTenantTransaction(
        pooled,
        { schoolId: value.b.school, userId: value.b.user },
        async (transaction) => {
          const [state] = await transaction<{ school: string }[]>`
            SELECT current_setting('app.school_id') AS school
          `;
          expect(state!.school).toBe(value.b.school);
          throw new Error("intentional rollback probe");
        },
      );
    } catch (error) {
      expect((error as Error).message).toBe("intentional rollback probe");
    }
    const afterRollback = await withTenantTransaction(
      pooled,
      { schoolId: value.b.school, userId: value.b.user },
      async (transaction) => {
        const [state] = await transaction<{ school: string }[]>`
          SELECT current_setting('app.school_id') AS school
        `;
        return state!.school;
      },
    );
    expect(afterRollback).toBe(value.b.school);
  } finally {
    await pooled.end({ timeout: 1 });
  }
}

async function runProbe(value: SeededFixture): Promise<void> {
  const coverage = await auditRlsCoverage(database!.sql as CatalogClient, 100);
  expect(coverage.violations, formatRlsCoverageReport(coverage)).toEqual([]);
  await assertCrossTenantCrud(value);
  await assertNormalizationAttack(value);
  await assertIndexPlans(value);
  await assertPoolIsolation(value);
}

describe("NFR-05 cross-tenant isolation", () => {
  beforeAll(async () => {
    if (!integrationEnabled) return;
    const setupStarted = performance.now();
    database = await testDatabase();
    await runMigrationCommand("migrate", {
      env: runnerEnv(database.url, repositoryMigrations),
      log: () => undefined,
    });
    const [schoolA, schoolB] = await createSchools(database.sql);
    const [a, b] = await Promise.all([
      seedTenant(database.sql, schoolA, "a"),
      seedTenant(database.sql, schoolB, "b"),
    ]);
    await database.sql.unsafe("ANALYZE");
    probePool = postgres(database.url, { max: PROBE_POOL_SIZE, ssl: false, prepare: false });
    fixture = { a, b, setupMs: performance.now() - setupStarted };
  }, 90_000);

  afterAll(async () => {
    await probePool?.end({ timeout: 1 });
    await database?.cleanup();
  });

  integrationTest(
    "blocks cross-tenant CRUD, constraint bypass, plan regressions, and pooled GUC leaks",
    async () => {
      await runProbe(fixture!); // warm catalogs, plans, and all four pooled paths
      const started = performance.now();
      await runProbe(fixture!);
      const elapsedMs = performance.now() - started;
      expect(
        elapsedMs,
        `NFR-05 warmed probe took ${elapsedMs.toFixed(2)}ms; budget <${PROBE_BUDGET_MS}ms; ` +
          `cold migrate/seed setup ${fixture!.setupMs.toFixed(2)}ms (reported, not gated)`,
      ).toBeLessThan(PROBE_BUDGET_MS);
    },
    90_000,
  );
});
