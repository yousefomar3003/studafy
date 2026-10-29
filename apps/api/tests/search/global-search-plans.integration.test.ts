/**
 * Global search query plans (migration 000171): EXPLAIN (FORMAT JSON) checks, in the style of
 * packages/db/tests/query-plan-budget.test.ts -- each probe is the WHERE shape of a section query in
 * apps/api/src/modules/search/service.ts.
 *
 * 1. No search index (a decision this file pins). Every searched table has FORCE RLS and no Studafy
 *    role has BYPASSRLS, and PostgreSQL will not make a non-LEAKPROOF qual such as `@@`
 *    (ts_match_vq) or `<%` (word_similarity_op) an index condition ahead of the policy quals. A GIN
 *    index on search_tsv or a trigram index on search_name could never be used by the API or by the
 *    candidate functions, so 000171 creates none (its header, point 4). The first block fails if one
 *    appears, so nobody re-adds a dead index -- with its write and disk cost -- without first
 *    showing an EXPLAIN under RLS that uses it.
 *
 * 2. Runtime plans (as studafy_app with the tenant GUCs, i.e. what the API actually runs): the match
 *    is always a Filter. What keeps the runtime query bounded instead:
 *      - students, classes, subjects, materials (per-row SECURITY DEFINER policy predicate): the
 *        rows are read one candidate id at a time (a nested loop over app.search_scoped_ids'
 *        output, through a school_id-bounded index), so the policy predicate runs only for
 *        candidates;
 *      - every other table: an index scan whose index condition is on school_id bounds the scan to
 *        the caller's school before the match filter.
 *    Asserted, as a teacher (the caller the per-row predicate is expensive for): no Seq Scan on the
 *    searched table, and for the scoped four, the candidate function (directly, or through the CTE
 *    that runs it once) driving the table access. The scoped four are planned with sequential scans
 *    enabled -- the API's own setting -- since their lateral OFFSET 0 fence must hold without any
 *    planner nudge; the
 *    tenant-only tables use enable_seqscan = off only because on a one-row fixture a seq scan is
 *    the right plan and would say nothing about whether an index bounds it.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/search/global-search-plans.integration.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createFullTenant,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TenantFixture, TestDatabase } from "../harness";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

interface PlanNode {
  "Node Type"?: string;
  "Index Name"?: string;
  "Relation Name"?: string;
  "Function Name"?: string;
  "Index Cond"?: string;
  "CTE Name"?: string;
  "Subplan Name"?: string;
  Plans?: PlanNode[];
}

function walk(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) walk(child, out);
  return out;
}

async function explain(tx: TransactionSql, query: string, params: string[]): Promise<PlanNode[]> {
  const rows = (await tx.unsafe(`EXPLAIN (FORMAT JSON) ${query}`, params)) as unknown as {
    "QUERY PLAN": { Plan: PlanNode }[];
  }[];
  return walk(rows[0]!["QUERY PLAN"][0]!.Plan);
}

let database: TestDatabase | undefined;
let tenant: TenantFixture;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  tenant = await createFullTenant(database.sql);
  await database.sql`ANALYZE`;
}, 120_000);

afterAll(async () => {
  await database?.cleanup();
});

/** Every table with a GENERATED search_tsv (000110 / 000171). */
const TSV_TABLES = [
  "students",
  "users",
  "invoice_cache",
  "materials",
  "classes",
  "courses",
  "sections",
  "subjects",
  "grade_levels",
  "academic_years",
  "terms",
  "rooms",
  "families",
  "announcements",
  "school_events",
  "discipline_incidents",
  "fee_structure_cache",
  "scholarships",
  "expense_cache",
  "notifications",
];

/** Every table with a GENERATED search_name for the trigram fallback (000171). */
const TRIGRAM_TABLES = ["students", "users", "classes", "subjects", "families"];

async function asApp<T>(
  fn: (tx: TransactionSql) => Promise<T>,
  { seqscan = false }: { seqscan?: boolean } = {},
): Promise<T> {
  let result: T | undefined;
  await database!.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
    await tx`SELECT set_config('app.user_id', ${tenant.teachers[0]!.userId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    if (!seqscan) await tx.unsafe("SET LOCAL enable_seqscan = off");
    await tx.unsafe("SET LOCAL pg_trgm.word_similarity_threshold = 0.5");
    result = await fn(tx);
  });
  return result as T;
}

describeDb("global search plans — no search index (FORCE RLS would never use one)", () => {
  test("the generated search columns exist, and no index covers either of them", async () => {
    const columns = await database!.sql<{ table: string; column: string }[]>`
      SELECT c.relname AS table, a.attname AS column
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = 'app'::regnamespace AND c.relkind IN ('r', 'p')
        AND a.attname IN ('search_tsv', 'search_name') AND a.attgenerated = 's' AND NOT a.attisdropped
    `;
    expect(columns.map((row) => `${row.table}.${row.column}`).sort()).toEqual(
      [
        ...TSV_TABLES.map((table) => `${table}.search_tsv`),
        ...TRIGRAM_TABLES.map((table) => `${table}.search_name`),
      ].sort(),
    );

    // Any index whose key, expression or predicate names either column, or that is named like a
    // search index; and any GIN or GiST index at all on a searched table (none of them has one for
    // another purpose), so a renamed column or index cannot slip a full-text/trigram index past this.
    const indexes = await database!.sql<{ name: string; definition: string }[]>`
      SELECT i.relname AS name, pg_get_indexdef(x.indexrelid) AS definition
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      WHERE t.relnamespace = 'app'::regnamespace
        AND (
          pg_get_indexdef(x.indexrelid) ~ 'search_(tsv|name)'
          OR i.relname ~ '_search_(tsv|name)'
          OR (
            t.relname = ANY(${TSV_TABLES})
            AND i.relam IN (SELECT oid FROM pg_am WHERE amname IN ('gin', 'gist'))
          )
        )
      ORDER BY 1
    `;
    expect(indexes.map((row) => `${row.name}: ${row.definition}`)).toEqual([]);
  });
});

/** Runtime probes: the FROM/WHERE shape of each section query in service.ts, as studafy_app. */
/**
 * The scoped full-text sections (students, classes, subjects) materialize the candidate ids in a
 * CTE so the same statement can also report whether the school has any candidate at all (the
 * typo-fallback rule, service.ts header); `scopedFts` wraps a page query in that shape.
 */
function scopedFts(kind: string, page: string, order: string): string {
  return `WITH q AS MATERIALIZED (SELECT to_tsquery('simple', app.search_normalize($2)) AS query),
    c AS MATERIALIZED (SELECT c.id FROM q CROSS JOIN LATERAL app.search_scoped_ids('${kind}', q.query) AS c(id)),
    page AS (${page})
    SELECT p.*, EXISTS (SELECT 1 FROM c) AS has_candidates
    FROM (VALUES (1)) AS one (x) LEFT JOIN page AS p ON true
    ORDER BY ${order}`;
}

const SCOPED_PROBES: Record<string, string> = {
  students: scopedFts(
    "students",
    `SELECT s.id, s.last_name, ts_rank(s.search_tsv, q.query) AS rank FROM q CROSS JOIN c
      CROSS JOIN LATERAL (SELECT * FROM app.students x
        WHERE x.id = c.id AND x.school_id = $1::uuid AND x.search_tsv @@ q.query OFFSET 0) s
      ORDER BY rank DESC, s.last_name, s.id LIMIT 20`,
    "p.rank DESC, p.last_name, p.id",
  ),
  classes: scopedFts(
    "classes",
    `SELECT cl.id, cl.code, ts_rank(cl.search_tsv || coalesce(co.search_tsv, ''::tsvector), q.query) AS rank
      FROM q CROSS JOIN c
      CROSS JOIN LATERAL (SELECT * FROM app.classes x WHERE x.id = c.id AND x.school_id = $1::uuid OFFSET 0) cl
      LEFT JOIN LATERAL (SELECT * FROM app.courses y
        WHERE y.id = cl.course_id AND y.school_id = cl.school_id OFFSET 0) co ON true
      WHERE (cl.search_tsv || coalesce(co.search_tsv, ''::tsvector)) @@ q.query
      ORDER BY rank DESC, cl.code, cl.id LIMIT 20`,
    "p.rank DESC, p.code, p.id",
  ),
  subjects: scopedFts(
    "subjects",
    `SELECT su.id, su.code, ts_rank(su.search_tsv, q.query) AS rank FROM q CROSS JOIN c
      CROSS JOIN LATERAL (SELECT * FROM app.subjects x
        WHERE x.id = c.id AND x.school_id = $1::uuid AND x.search_tsv @@ q.query OFFSET 0) su
      ORDER BY rank DESC, su.code, su.id LIMIT 20`,
    "p.rank DESC, p.code, p.id",
  ),
  materials: `SELECT m.id FROM to_tsquery('english', app.search_normalize($2)) AS q(query)
    CROSS JOIN LATERAL app.search_scoped_ids('materials', q.query) AS c(id)
    CROSS JOIN LATERAL (SELECT * FROM app.materials x
      WHERE x.id = c.id AND x.school_id = $1::uuid AND x.search_tsv @@ q.query OFFSET 0) m`,
  "students (typo)": `SELECT s.id FROM app.search_normalize($2) AS q(needle)
    CROSS JOIN LATERAL app.search_scoped_fuzzy_ids('students', q.needle) AS c(id)
    CROSS JOIN LATERAL (SELECT * FROM app.students x
      WHERE x.id = c.id AND x.school_id = $1::uuid AND q.needle <% x.search_name OFFSET 0) s`,
};

const TENANT_PROBES: Record<string, string> = {
  users: `SELECT u.id FROM app.users u, to_tsquery('simple', app.search_normalize($2)) q(query)
    WHERE u.school_id = $1::uuid AND u.search_tsv @@ q.query`,
  invoice_cache: `SELECT ic.id FROM app.invoice_cache ic, to_tsquery('simple', app.search_normalize($2)) q(query)
    WHERE ic.school_id = $1::uuid AND ic.search_tsv @@ q.query`,
  sections: `SELECT s.id FROM app.sections s JOIN app.grade_levels g ON g.id = s.grade_level_id AND g.school_id = s.school_id
    CROSS JOIN to_tsquery('simple', app.search_normalize($2)) q(query)
    WHERE s.school_id = $1::uuid AND (s.search_tsv || g.search_tsv) @@ q.query`,
  grade_levels: `SELECT g.id FROM app.grade_levels g, to_tsquery('simple', app.search_normalize($2)) q(query)
    WHERE g.school_id = $1::uuid AND g.search_tsv @@ q.query`,
  academic_years: `SELECT y.id FROM app.academic_years y, to_tsquery('simple', app.search_normalize($2)) q(query)
    WHERE y.school_id = $1::uuid AND y.search_tsv @@ q.query`,
  terms: `SELECT t.id FROM app.terms t, to_tsquery('simple', app.search_normalize($2)) q(query)
    WHERE t.school_id = $1::uuid AND t.search_tsv @@ q.query`,
  rooms: `SELECT r.id FROM app.rooms r, to_tsquery('simple', app.search_normalize($2)) q(query)
    WHERE r.school_id = $1::uuid AND r.search_tsv @@ q.query`,
  families: `SELECT f.id FROM app.families f, to_tsquery('simple', app.search_normalize($2)) q(query)
    WHERE f.school_id = $1::uuid AND f.search_tsv @@ q.query`,
  announcements: `SELECT a.id FROM app.announcements a, to_tsquery('simple', app.search_normalize($2)) q(query)
    WHERE a.school_id = $1::uuid AND a.search_tsv @@ q.query`,
  school_events: `SELECT e.id FROM app.school_events e, to_tsquery('simple', app.search_normalize($2)) q(query)
    WHERE e.school_id = $1::uuid AND e.search_tsv @@ q.query`,
  discipline_incidents: `SELECT i.id FROM app.discipline_incidents i, to_tsquery('simple', app.search_normalize($2)) q(query)
    WHERE i.school_id = $1::uuid AND i.search_tsv @@ q.query`,
  fee_structure_cache: `SELECT fs.id FROM app.fee_structure_cache fs, to_tsquery('simple', app.search_normalize($2)) q(query)
    WHERE fs.school_id = $1::uuid AND fs.search_tsv @@ q.query`,
  scholarships: `SELECT sc.id FROM app.scholarships sc, to_tsquery('simple', app.search_normalize($2)) q(query)
    WHERE sc.school_id = $1::uuid AND sc.search_tsv @@ q.query`,
  expense_cache: `SELECT ex.id FROM app.expense_cache ex, to_tsquery('simple', app.search_normalize($2)) q(query)
    WHERE ex.school_id = $1::uuid AND ex.search_tsv @@ q.query`,
  notifications: `SELECT n.id FROM app.notifications n, to_tsquery('simple', app.search_normalize($2)) q(query)
    WHERE n.school_id = $1::uuid AND n.user_id = $3::uuid AND n.search_tsv @@ q.query`,
  teacher_evaluations: `SELECT e.id FROM app.teacher_evaluations e
    JOIN app.teachers t ON t.id = e.teacher_id AND t.school_id = e.school_id
    JOIN app.users u ON u.id = t.user_id AND u.school_id = t.school_id
    CROSS JOIN to_tsquery('simple', app.search_normalize($2)) q(query)
    WHERE e.school_id = $1::uuid AND u.search_tsv @@ q.query`,
};

/**
 * True when this access to the relation is bounded by an index condition on school_id: an index
 * (only) scan whose Index Cond names it, or a bitmap heap scan fed by such a bitmap index scan.
 */
function schoolBounded(node: PlanNode): boolean {
  const conditions =
    node["Node Type"] === "Bitmap Heap Scan"
      ? walk(node)
          .filter((child) => child["Node Type"] === "Bitmap Index Scan")
          .map((child) => child["Index Cond"] ?? "")
      : [node["Index Cond"] ?? ""];
  return conditions.some((condition) => condition.includes("school_id"));
}

function relationOf(label: string): string {
  return label.split(" ")[0]!;
}

describeDb("global search plans — runtime role (studafy_app, RLS on)", () => {
  test.each(Object.entries(SCOPED_PROBES))(
    "%s: rows are read per candidate, driven by the scoped candidate function",
    async (label, query) => {
      const relation = relationOf(label);
      const fn = label.includes("typo") ? "search_scoped_fuzzy_ids" : "search_scoped_ids";
      const params = [tenant.schoolId, "omar & kh:*"];

      // Planner settings as the API runs them (sequential scans allowed): the lateral OFFSET 0 fence
      // must on its own make the table the inner side of a nested loop over the candidates, so the
      // per-row policy predicate runs once per candidate -- never a hash join over the whole table.
      const root = await asApp(
        async (tx) => {
          const rows = (await tx.unsafe(`EXPLAIN (FORMAT JSON) ${query}`, params)) as unknown as {
            "QUERY PLAN": { Plan: PlanNode }[];
          }[];
          return rows[0]!["QUERY PLAN"][0]!.Plan;
        },
        { seqscan: true },
      );
      // The outer side is the candidate function itself, or a scan of the CTE that runs it once.
      const drivesFromCandidates = (side: PlanNode) =>
        walk(side).some(
          (child) =>
            child["Function Name"] === fn ||
            (child["Node Type"] === "CTE Scan" && child["CTE Name"] === "c"),
        );
      const loops = walk(root).filter(
        (node) =>
          node["Node Type"] === "Nested Loop" &&
          drivesFromCandidates(node.Plans![0]!) &&
          walk(node.Plans![1]!).some((child) => child["Relation Name"] === relation),
      );
      expect(loops.length).toBeGreaterThan(0);
      if (!label.includes("typo") && relation !== "materials") {
        // The CTE behind that scan is the candidate function, run once per statement.
        const cte = walk(root).find(
          (node) =>
            node["Subplan Name"] === "CTE c" && walk(node).some((n) => n["Function Name"] === fn),
        );
        expect(cte).toBeDefined();
      }
      expect(walk(root).map((node) => node["Node Type"])).not.toContain("Hash Join");

      // And that inner access is an index scan, never a Seq Scan, with school_id as an index
      // condition (forced here; on a one-row fixture a one-row seq scan per candidate is cheaper).
      // Which school-leading btree serves the per-candidate id lookup is a cost tie on a fixture
      // this small, so the index name is not pinned.
      const nodes = await asApp((tx) => explain(tx, query, params));
      const access = nodes.filter((node) => node["Relation Name"] === relation);
      expect(access.length).toBeGreaterThan(0);
      expect(access.map((node) => node["Node Type"])).not.toContain("Seq Scan");
      expect(access.every(schoolBounded)).toBe(true);
    },
  );

  test.each(Object.entries(TENANT_PROBES))(
    "app.%s: the scan is bounded to the caller's school by a school_id index condition",
    async (relation, query) => {
      const params = [tenant.schoolId, "omar & kh:*"];
      if (query.includes("$3")) params.push(tenant.teachers[0]!.userId);
      const nodes = await asApp((tx) => explain(tx, query, params));
      const access = nodes.filter((node) => node["Relation Name"] === relation);
      expect(access.length).toBeGreaterThan(0);
      expect(access.map((node) => node["Node Type"])).not.toContain("Seq Scan");
      // With no search index the only thing bounding the scan is a school_id-leading btree; the
      // full-text match is a Filter on top of it.
      expect(access.map((node) => [node["Node Type"], schoolBounded(node)])).toEqual(
        access.map((node) => [node["Node Type"], true]),
      );
    },
  );

  test("inside the candidate function (studafy_admin) the scan is school-bounded too", async () => {
    let nodes: PlanNode[] = [];
    await database!.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx.unsafe("SET LOCAL enable_seqscan = off");
      nodes = await explain(
        tx,
        `SELECT s.id FROM app.students s
           WHERE s.school_id = current_setting('app.school_id')::uuid
             AND s.search_tsv @@ to_tsquery('simple', $1)`,
        ["omar & kh:*"],
      );
    });
    const access = nodes.filter((node) => node["Relation Name"] === "students");
    expect(access.length).toBeGreaterThan(0);
    expect(access.map((node) => node["Node Type"])).not.toContain("Seq Scan");
    expect(access.every(schoolBounded)).toBe(true);
  });
});
