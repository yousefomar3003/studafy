// Post-seed index health check. Two independent signals:
//
//   1. Validity: every index in schema app must be indisvalid AND indisready. This catches, in
//      particular, an INVALID index left behind by a failed CREATE INDEX CONCURRENTLY (migration
//      000024 builds notification_preferences' index concurrently).
//
//   2. Usability: representative tenant queries over the seeded rows must be *served* by an index.
//      Because the demo dataset is small, the planner would normally prefer a sequential scan on cost
//      grounds, which says nothing about index health. So each probe runs with enable_seqscan = off:
//      if a valid, applicable index exists, the planner uses it; if the plan still falls back to a
//      Seq Scan, the index that should serve that access path is missing or unusable. This proves the
//      index is healthy and usable for its query shape, independent of row-count-driven plan choice.
//
// It is invoked at the end of seed.ts and is also runnable on its own (bun db/seeds/index-health.ts),
// behind the same production guard as the seed. Read-only: it runs inside a transaction it rolls back.
import { createClient } from "../../packages/db/src/client";
import { loadMigrationConfig, redact } from "../../packages/db/src/config";

import { DEMO_SCHOOL_SLUG } from "./data/school";
import { assertSeedAllowed, SeedSafetyError } from "./guard";

import type { ReservedSql } from "../../packages/db/src/client";
import type { MigrationConfig } from "../../packages/db/src/config";

const INDEX_SCAN_NODES = new Set(["Index Scan", "Index Only Scan", "Bitmap Index Scan"]);

export interface IndexValidityIssue {
  readonly schemaName: string;
  readonly tableName: string;
  readonly indexName: string;
  readonly isValid: boolean;
  readonly isReady: boolean;
}

export interface IndexProbe {
  readonly name: string;
  readonly description: string;
  readonly usedIndex: boolean;
  readonly indexNames: readonly string[];
  readonly nodeTypes: readonly string[];
}

export interface IndexHealthReport {
  readonly healthy: boolean;
  readonly schoolFound: boolean;
  readonly totalIndexes: number;
  readonly invalidIndexes: readonly IndexValidityIssue[];
  readonly probes: readonly IndexProbe[];
}

interface PlanNode {
  "Node Type"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function walkPlan(node: PlanNode, nodeTypes: string[], indexNames: string[]): void {
  if (node["Node Type"]) nodeTypes.push(node["Node Type"]);
  if (node["Index Name"]) indexNames.push(node["Index Name"]);
  for (const child of node.Plans ?? []) walkPlan(child, nodeTypes, indexNames);
}

async function explain(
  sql: ReservedSql,
  name: string,
  description: string,
  query: string,
  parameters: string[],
): Promise<IndexProbe> {
  const rows = (await sql.unsafe(`EXPLAIN (FORMAT JSON) ${query}`, parameters)) as unknown as {
    "QUERY PLAN": { Plan: PlanNode }[];
  }[];
  const root = rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
  const nodeTypes: string[] = [];
  const indexNames: string[] = [];
  if (root) walkPlan(root, nodeTypes, indexNames);
  return {
    name,
    description,
    usedIndex: nodeTypes.some((type) => INDEX_SCAN_NODES.has(type)),
    indexNames,
    nodeTypes,
  };
}

async function first<T>(sql: ReservedSql, query: string): Promise<T | undefined> {
  const rows = (await sql.unsafe(query)) as unknown as T[];
  return rows[0];
}

export interface IndexHealthOptions {
  readonly env?: Record<string, string | undefined>;
  readonly schoolSlug?: string;
}

export async function checkIndexHealth(
  options: IndexHealthOptions = {},
): Promise<IndexHealthReport> {
  const config: MigrationConfig = loadMigrationConfig(options.env);
  const schoolSlug = options.schoolSlug ?? DEMO_SCHOOL_SLUG;
  const client = createClient(config, "studafy-index-health");
  let reserved: ReservedSql | undefined;

  try {
    reserved = await client.reserve();
    await reserved.unsafe("BEGIN");
    await reserved.unsafe("SET LOCAL ROLE studafy_admin");
    await reserved.unsafe("SET LOCAL enable_seqscan = off");

    const invalidIndexes = (await reserved.unsafe(`
      SELECT n.nspname AS "schemaName", parent.relname AS "tableName",
             index_relation.relname AS "indexName",
             index_catalog.indisvalid AS "isValid", index_catalog.indisready AS "isReady"
      FROM pg_catalog.pg_index AS index_catalog
      JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_catalog.indexrelid
      JOIN pg_catalog.pg_class AS parent ON parent.oid = index_catalog.indrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = parent.relnamespace
      WHERE n.nspname = 'app' AND (NOT index_catalog.indisvalid OR NOT index_catalog.indisready)
      ORDER BY parent.relname, index_relation.relname
    `)) as unknown as IndexValidityIssue[];

    const [{ total }] = (await reserved.unsafe(`
      SELECT count(*)::int AS total
      FROM pg_catalog.pg_index AS index_catalog
      JOIN pg_catalog.pg_class AS parent ON parent.oid = index_catalog.indrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = parent.relnamespace
      WHERE n.nspname = 'app'
    `)) as unknown as { total: number }[];

    const school = await first<{ id: string }>(
      reserved,
      `SELECT id FROM app.schools WHERE slug = '${schoolSlug.replaceAll("'", "''")}'`,
    );

    const probes: IndexProbe[] = [];
    if (school) {
      await reserved.unsafe(`SELECT set_config('app.school_id', $1, true)`, [school.id]);

      const notified = await first<{ user_id: string }>(
        reserved,
        "SELECT user_id FROM app.notifications LIMIT 1",
      );
      const klass = await first<{ id: string }>(reserved, "SELECT id FROM app.classes LIMIT 1");
      const material = await first<{ material_id: string }>(
        reserved,
        "SELECT material_id FROM app.material_chunks LIMIT 1",
      );
      const session = await first<{ attendance_session_id: string }>(
        reserved,
        "SELECT attendance_session_id FROM app.attendance_records LIMIT 1",
      );

      if (notified) {
        probes.push(
          await explain(
            reserved,
            "notifications_unread",
            "a user's unread notifications, newest first",
            "SELECT id FROM app.notifications WHERE school_id = $1 AND user_id = $2 AND read_at IS NULL ORDER BY created_at DESC",
            [school.id, notified.user_id],
          ),
        );
      }
      if (klass) {
        probes.push(
          await explain(
            reserved,
            "enrollments_by_class",
            "the roster of one class",
            "SELECT student_id FROM app.enrollments WHERE school_id = $1 AND class_id = $2",
            [school.id, klass.id],
          ),
        );
      }
      if (material) {
        probes.push(
          await explain(
            reserved,
            "material_chunks_by_material",
            "one material's chunks in order",
            "SELECT id FROM app.material_chunks WHERE school_id = $1 AND material_id = $2 ORDER BY chunk_index",
            [school.id, material.material_id],
          ),
        );
      }
      if (session) {
        probes.push(
          await explain(
            reserved,
            "attendance_records_by_session",
            "one attendance session's records",
            "SELECT id FROM app.attendance_records WHERE school_id = $1 AND attendance_session_id = $2",
            [school.id, session.attendance_session_id],
          ),
        );
      }
    }

    await reserved.unsafe("ROLLBACK");

    const healthy = invalidIndexes.length === 0 && probes.every((probe) => probe.usedIndex);
    return {
      healthy,
      schoolFound: Boolean(school),
      totalIndexes: total,
      invalidIndexes,
      probes,
    };
  } catch (error) {
    if (reserved) {
      try {
        await reserved.unsafe("ROLLBACK");
      } catch {
        // connection already gone
      }
    }
    if (error instanceof Error) error.message = redact(error.message, config.redactions);
    throw error;
  } finally {
    reserved?.release();
    await client.end({ timeout: 5 });
  }
}

export function formatIndexHealthReport(report: IndexHealthReport): string {
  const lines: string[] = [];
  if (report.healthy) {
    lines.push(
      `Index health PASS: ${report.totalIndexes} app indexes valid and ready; ` +
        `${report.probes.length} seed query probe(s) served by an index.`,
    );
  } else {
    lines.push(
      `Index health FAIL: ${report.invalidIndexes.length} invalid index(es); ` +
        `${report.probes.filter((p) => !p.usedIndex).length}/${report.probes.length} probe(s) not index-served.`,
    );
  }
  if (!report.schoolFound) {
    lines.push(
      "  note: demo school not found; query probes were skipped (validity check still ran).",
    );
  }
  for (const issue of report.invalidIndexes) {
    lines.push(
      `  INVALID: app.${issue.tableName} index ${issue.indexName} ` +
        `(valid=${issue.isValid}, ready=${issue.isReady})`,
    );
  }
  for (const probe of report.probes) {
    const marker = probe.usedIndex ? "ok" : "SEQ SCAN";
    const indexes = probe.indexNames.length > 0 ? probe.indexNames.join(", ") : "none";
    lines.push(`  [${marker}] ${probe.name}: ${probe.description} -> ${indexes}`);
  }
  return lines.join("\n");
}

export async function main(): Promise<number> {
  try {
    assertSeedAllowed(process.env, loadMigrationConfig());
  } catch (error) {
    if (error instanceof SeedSafetyError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

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
