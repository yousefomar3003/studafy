#!/usr/bin/env bun
// The unified demo-tenant seed entrypoint: `bun run db:seed`.
//
// Envelope (mirrors packages/db/src/partitions.ts): production guard -> connect with the administrative
// identity -> reserve one connection -> take the shared migration advisory lock -> abort if the demo
// tenant already exists -> one transaction that runs as studafy_admin with app.school_id set and calls
// every data module in dependency order -> COMMIT -> post-seed index health check. The lock and
// connection are always released in finally.
//
// The whole dataset is written in a single transaction, so a failure anywhere leaves the database
// exactly as it was. Re-running against an already-seeded database is a clean, explicit no-op.
import { createClient } from "../../packages/db/src/client";
import { loadMigrationConfig, redact } from "../../packages/db/src/config";
import { MigrationLockError } from "../../packages/db/src/errors";
import { ADVISORY_LOCK_KEY } from "../../packages/db/src/runner";

import { seedAcademics } from "./data/academics";
import { seedAi } from "./data/ai";
import { seedAssessments } from "./data/assessments";
import { seedEngagement } from "./data/engagement";
import { seedFinance } from "./data/finance";
import { seedMaterials } from "./data/materials";
import { seedPeople } from "./data/people";
import { DEMO_SCHOOL_NAME, DEMO_SCHOOL_SLUG, seedSchool } from "./data/school";
import { seedTimetableAndAttendance } from "./data/timetable";
import { assertSeedAllowed, SeedSafetyError } from "./guard";
import { checkIndexHealth, formatIndexHealthReport } from "./index-health";

import type { FullCtx } from "./support";
import type { ReservedSql } from "../../packages/db/src/client";

// Tenant + global tables reported in the post-seed summary. Counting runs inside the transaction with
// app.school_id set, so tenant tables report the demo school's own rows.
const SUMMARY_TABLES = [
  "schools",
  "users",
  "user_roles",
  "oauth_identities",
  "students",
  "teachers",
  "parent_child_links",
  "academic_years",
  "terms",
  "subjects",
  "courses",
  "rooms",
  "classes",
  "enrollments",
  "timetable_versions",
  "timetable_slots",
  "attendance_sessions",
  "attendance_records",
  "assignments",
  "assignment_submissions",
  "exams",
  "exam_results",
  "gradebooks",
  "grade_submissions",
  "grades",
  "materials",
  "material_chunks",
  "invoice_cache",
  "payment_cache",
  "fee_schedule_cache",
  "erpnext_id_mappings",
  "subscriptions",
  "ai_subscriptions",
  "ai_conversations",
  "ai_messages",
  "ai_message_citations",
  "ai_usage_meters",
  "notifications",
  "notification_preferences",
  "user_devices",
  "outbox_events",
  "audit_logs",
] as const;

export interface TableCount {
  readonly table_name: string;
  readonly row_count: number;
}

export interface SeedResult {
  readonly seeded: boolean;
  readonly schoolId?: string;
  readonly elapsedMs?: number;
  readonly counts?: readonly TableCount[];
}

export interface SeedOptions {
  readonly env?: Record<string, string | undefined>;
}

async function tableCounts(sql: ReservedSql): Promise<TableCount[]> {
  // SUMMARY_TABLES is a closed, in-repo constant list, never caller input.
  const query =
    SUMMARY_TABLES.map(
      (table) => `SELECT '${table}' AS table_name, count(*)::int AS row_count FROM app.${table}`,
    ).join(" UNION ALL ") + " ORDER BY table_name";
  return (await sql.unsafe(query)) as unknown as TableCount[];
}

export async function seedDemoTenant(options: SeedOptions = {}): Promise<SeedResult> {
  const env = options.env ?? process.env;
  const config = loadMigrationConfig(env);
  assertSeedAllowed(env, config);

  const client = createClient(config, "studafy-seed");
  let reserved: ReservedSql | undefined;
  let locked = false;

  try {
    reserved = await client.reserve();

    const [lock] = await reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY.toString()}) AS locked
    `;
    if (!lock?.locked) {
      throw new MigrationLockError("Another migration or seed process holds the lock");
    }
    locked = true;

    const [existing] = await reserved<{ one: number }[]>`
      SELECT 1 AS one FROM app.schools WHERE slug = ${DEMO_SCHOOL_SLUG}
    `;
    if (existing) return { seeded: false };

    const start = performance.now();
    let counts: TableCount[];
    let schoolId: string;
    try {
      await reserved.unsafe("BEGIN");
      await reserved.unsafe("SET LOCAL ROLE studafy_admin");

      const school = await seedSchool(reserved);
      schoolId = school.schoolId;
      const people = await seedPeople(reserved, school);
      const academics = await seedAcademics(reserved, { ...school, ...people });
      const ctx: FullCtx = { ...school, ...people, ...academics };

      await seedTimetableAndAttendance(reserved, ctx);
      await seedAssessments(reserved, ctx);
      const materials = await seedMaterials(reserved, ctx);
      await seedFinance(reserved, ctx);
      await seedAi(reserved, ctx, materials);
      await seedEngagement(reserved, ctx);

      counts = await tableCounts(reserved);
      await reserved.unsafe("COMMIT");
    } catch (error) {
      await reserved.unsafe("ROLLBACK");
      throw error;
    }

    return { seeded: true, schoolId, elapsedMs: performance.now() - start, counts };
  } catch (error) {
    if (error instanceof Error) error.message = redact(error.message, config.redactions);
    throw error;
  } finally {
    if (reserved && locked) {
      try {
        await reserved`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY.toString()})`;
      } catch {
        // A lost session has already released its PostgreSQL advisory lock.
      }
    }
    reserved?.release();
    await client.end({ timeout: 5 });
  }
}

export async function main(): Promise<number> {
  let result: SeedResult;
  try {
    result = await seedDemoTenant();
  } catch (error) {
    if (error instanceof SeedSafetyError) {
      console.error(error.message);
      return 1;
    }
    console.error(`SeedExecutionError: ${error instanceof Error ? error.message : "seed failed"}`);
    return 1;
  }

  if (!result.seeded) {
    console.error(
      `Seed skipped: demo tenant '${DEMO_SCHOOL_SLUG}' already exists. ` +
        "Recreate or re-migrate a fresh database to reseed.",
    );
    return 1;
  }

  const totalRows = (result.counts ?? []).reduce((sum, row) => sum + row.row_count, 0);
  console.log(`Seeded '${DEMO_SCHOOL_NAME}' (${DEMO_SCHOOL_SLUG}):`);
  for (const row of result.counts ?? []) {
    console.log(`  ${row.table_name.padEnd(26)} ${String(row.row_count).padStart(5)}`);
  }
  console.log(
    `Total ${totalRows} rows across ${result.counts?.length ?? 0} tables in ` +
      `${Math.round(result.elapsedMs ?? 0)}ms.`,
  );

  // Post-seed index health, using the freshly seeded rows.
  try {
    const report = await checkIndexHealth();
    const output = formatIndexHealthReport(report);
    if (report.healthy) console.log(output);
    else console.error(output);
    return report.healthy ? 0 : 1;
  } catch (error) {
    console.error(
      `IndexHealthExecutionError: ${error instanceof Error ? error.message : "index health check failed"}`,
    );
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
