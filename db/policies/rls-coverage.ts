export const RLS_COVERAGE_BUDGET_MS = 100;
export const RLS_COVERAGE_MEASUREMENT_COUNT = 20;
export const RLS_COVERAGE_WARMUP_COUNT = 5;

export interface CatalogClient {
  unsafe(
    query: string,
    parameters?: unknown[],
    options?: { prepare?: boolean },
  ): PromiseLike<unknown>;
}

export interface RlsCoverageViolation {
  ruleCode: string;
  schemaName: string;
  tableName: string;
  columnName: string | null;
  catalogState: string;
  remediation: string;
  diagnosticSql: string | null;
  explainPlan?: string;
}

export interface RlsCoverageReport {
  compliant: boolean;
  measurementCount: number;
  warmupCount: number;
  elapsedMs: number;
  budgetMs: number;
  appRelations: number;
  tenantRelations: number;
  violations: RlsCoverageViolation[];
}

interface CatalogRow {
  rule_code: string;
  schema_name: string;
  table_name: string;
  column_name: string | null;
  catalog_state: string;
  remediation: string;
  diagnostic_sql: string | null;
  app_relations: number;
  tenant_relations: number;
}

interface ExplainRow {
  "QUERY PLAN": {
    "Planning Time": number;
    "Execution Time": number;
  }[];
}

// One read-only catalog statement produces the complete compliance result; the performance harness
// wraps that same statement in EXPLAIN ANALYZE. pg_index/pg_attribute attnums are used for index/FK
// structure rather than parsing human-readable definitions; pg_indexes and pg_policies provide those
// definitions and policy metadata for the diagnostic report.
export const RLS_COVERAGE_QUERY = String.raw`
WITH
approved_globals(table_name) AS (
  VALUES
    ('billing_events'),
    ('countries'),
    ('currencies'),
    ('plan_prices'),
    ('plans'),
    ('platform_settings'),
    ('schools'),
    -- Boundary rejections raised before authentication (ST-067). Global by construction: the
    -- requests it records never established a tenant, so there is no school_id to isolate by.
    -- See db/migrations/000028_create_security_events_table.sql for the full rationale.
    ('security_events')
),
approved_flexible_columns(table_name, column_name) AS (
  VALUES
    ('audit_logs', 'new_values'),
    ('audit_logs', 'old_values'),
    ('billing_events', 'payload'),
    ('fee_schedule_cache', 'erpnext_payload'),
    ('fee_structure_cache', 'erpnext_payload'),
    ('finance_sync_outbox', 'payload'),
    ('invoice_cache', 'erpnext_payload'),
    ('notifications', 'metadata'),
    ('outbox_events', 'payload'),
    ('payment_cache', 'erpnext_payload'),
    ('expense_cache', 'erpnext_payload'),
    ('award_cache', 'erpnext_payload'),
    ('scholarship_discount_cache', 'erpnext_payload'),
    ('installment_cache', 'erpnext_payload'),
    ('finance_reconciliation_logs', 'unresolved_divergences'),
    ('student_imports', 'rows_data'),
    ('student_imports', 'errors'),
    ('student_imports', 'summary')
),
relations AS (
  SELECT
    c.oid,
    n.nspname AS schema_name,
    c.relname AS table_name,
    c.relkind,
    c.relispartition,
    c.relrowsecurity,
    c.relforcerowsecurity,
    c.relowner,
    school.attnum AS school_attnum,
    school.attnotnull AS school_not_null,
    school.atttypid AS school_type_oid,
    school.atttypmod AS school_typmod
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_attribute AS school
    ON school.attrelid = c.oid
   AND school.attname = 'school_id'
   AND school.attnum > 0
   AND NOT school.attisdropped
  WHERE n.nspname = 'app'
    AND c.relkind IN ('r', 'p')
),
tenant_relations AS (
  SELECT * FROM relations WHERE school_attnum IS NOT NULL
),
schools_key AS (
  SELECT c.oid, id.attnum, id.atttypid, id.atttypmod
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute AS id
    ON id.attrelid = c.oid
   AND id.attname = 'id'
   AND id.attnum > 0
   AND NOT id.attisdropped
  WHERE n.nspname = 'app' AND c.relname = 'schools' AND c.relkind = 'r'
),
index_state AS (
  SELECT
    tenant.oid AS table_oid,
    tenant.table_name,
    index_catalog.indexrelid,
    index_catalog.indnkeyatts,
    index_catalog.indisvalid,
    index_catalog.indisready,
    index_catalog.indisunique,
    index_catalog.indisprimary,
    index_catalog.indpred,
    index_catalog.indexprs,
    (index_catalog.indkey::smallint[])[0] AS first_attnum,
    access_method.amname,
    index_relation.relname AS index_name
  FROM tenant_relations AS tenant
  JOIN pg_catalog.pg_index AS index_catalog ON index_catalog.indrelid = tenant.oid
  JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_catalog.indexrelid
  JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_relation.relam
),
violations AS (
  SELECT
    'UNCLASSIFIED_TABLE'::text AS rule_code,
    relation.schema_name,
    relation.table_name,
    NULL::text AS column_name,
    format('relkind=%s owner=%s', relation.relkind, pg_catalog.pg_get_userbyid(relation.relowner)) AS catalog_state,
    'Add a non-null school_id and tenant controls, or document and add this table to the approved global allowlist.'::text AS remediation,
    NULL::text AS diagnostic_sql
  FROM relations AS relation
  LEFT JOIN approved_globals AS approved ON approved.table_name = relation.table_name
  WHERE relation.school_attnum IS NULL
    AND approved.table_name IS NULL

  UNION ALL

  SELECT
    'GLOBAL_SCOPE_DRIFT', relation.schema_name, relation.table_name, 'school_id',
    'approved global table unexpectedly contains school_id',
    'Remove the global classification or redesign the table as a fully protected tenant relation.',
    NULL
  FROM relations AS relation
  JOIN approved_globals AS approved ON approved.table_name = relation.table_name
  WHERE relation.school_attnum IS NOT NULL

  UNION ALL

  SELECT
    'SCHOOL_ID_SHAPE', tenant.schema_name, tenant.table_name, 'school_id',
    format('type=%s not_null=%s',
      pg_catalog.format_type(tenant.school_type_oid, tenant.school_typmod), tenant.school_not_null),
    'Make school_id a non-null UUID matching app.schools(id).',
    NULL
  FROM tenant_relations AS tenant
  CROSS JOIN schools_key AS school
  WHERE NOT tenant.school_not_null
     OR tenant.school_type_oid <> school.atttypid
     OR tenant.school_typmod <> school.atttypmod

  UNION ALL

  SELECT
    'SCHOOL_FOREIGN_KEY', tenant.schema_name, tenant.table_name, 'school_id',
    'no validated single-column foreign key to app.schools(id)',
    'Add FOREIGN KEY (school_id) REFERENCES app.schools(id) with explicit update/delete behavior.',
    NULL
  FROM tenant_relations AS tenant
  CROSS JOIN schools_key AS school
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_catalog
    WHERE constraint_catalog.conrelid = tenant.oid
      AND constraint_catalog.contype = 'f'
      AND constraint_catalog.convalidated
      AND constraint_catalog.confrelid = school.oid
      AND constraint_catalog.conkey = ARRAY[tenant.school_attnum]::smallint[]
      AND constraint_catalog.confkey = ARRAY[school.attnum]::smallint[]
  )

  UNION ALL

  SELECT
    'RLS_ENABLED', tenant.schema_name, tenant.table_name, NULL,
    format('pg_class.relrowsecurity=%s pg_tables.rowsecurity=%s',
      tenant.relrowsecurity,
      coalesce((
        SELECT tables.rowsecurity::text
        FROM pg_catalog.pg_tables AS tables
        WHERE tables.schemaname = tenant.schema_name
          AND tables.tablename = tenant.table_name
      ), 'n/a')),
    'Run ALTER TABLE ... ENABLE ROW LEVEL SECURITY in a forward migration.',
    NULL
  FROM tenant_relations AS tenant
  WHERE NOT tenant.relrowsecurity

  UNION ALL

  SELECT
    'RLS_FORCED', tenant.schema_name, tenant.table_name, NULL,
    format('pg_class.relforcerowsecurity=%s', tenant.relforcerowsecurity),
    'Run ALTER TABLE ... FORCE ROW LEVEL SECURITY in a forward migration.',
    NULL
  FROM tenant_relations AS tenant
  WHERE NOT tenant.relforcerowsecurity

  UNION ALL

  SELECT
    'TENANT_OWNERSHIP_IMMUTABLE', tenant.schema_name, tenant.table_name, 'school_id',
    'no enabled BEFORE UPDATE OF school_id trigger using app.reject_tenant_school_id_mutation()',
    'Install the canonical tenant-ownership trigger in a forward migration.',
    format(
      'SELECT app.apply_tenant_ownership_immutability(%L::name, %L::name);',
      tenant.schema_name, tenant.table_name
    )
  FROM tenant_relations AS tenant
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_catalog
    JOIN pg_catalog.pg_proc AS trigger_function
      ON trigger_function.oid = trigger_catalog.tgfoid
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = trigger_function.pronamespace
    WHERE trigger_catalog.tgrelid = tenant.oid
      AND NOT trigger_catalog.tgisinternal
      AND trigger_catalog.tgenabled <> 'D'
      AND function_schema.nspname = 'app'
      AND trigger_function.proname = 'reject_tenant_school_id_mutation'
      AND trigger_function.pronargs = 0
      AND (trigger_catalog.tgtype & 1) = 1
      AND (trigger_catalog.tgtype & 2) = 2
      AND (trigger_catalog.tgtype & 16) = 16
      AND tenant.school_attnum = ANY(trigger_catalog.tgattr::smallint[])
  )

  UNION ALL

  SELECT
    'TENANT_POLICY', tenant.schema_name, tenant.table_name, 'school_id',
    coalesce((
      SELECT string_agg(
        format('%s permissive=%s command=%s roles=%s using=%s check=%s',
          policy_view.policyname,
          policy_view.permissive,
          policy_view.cmd,
          policy_view.roles,
          policy_view.qual,
          policy_view.with_check),
        '; ' ORDER BY policy_view.policyname
      )
      FROM pg_catalog.pg_policies AS policy_view
      WHERE policy_view.schemaname = tenant.schema_name
        AND policy_view.tablename = tenant.table_name
    ), 'no policies'),
    'Install the exact canonical FOR ALL TO PUBLIC tenant_isolation USING/WITH CHECK policy.',
    NULL
  FROM tenant_relations AS tenant
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_catalog
    WHERE policy_catalog.polrelid = tenant.oid
      AND policy_catalog.polname = 'tenant_isolation'
      AND policy_catalog.polcmd = '*'
      AND policy_catalog.polpermissive
      AND policy_catalog.polroles = ARRAY[0::oid]
      AND pg_catalog.translate(
        pg_catalog.replace(pg_catalog.pg_get_expr(policy_catalog.polqual, policy_catalog.polrelid), '::text', ''),
        E' \n\t\r()', ''
      ) = 'school_id=current_setting''app.school_id''::uuid'
      AND pg_catalog.translate(
        pg_catalog.replace(pg_catalog.pg_get_expr(policy_catalog.polwithcheck, policy_catalog.polrelid), '::text', ''),
        E' \n\t\r()', ''
      ) = 'school_id=current_setting''app.school_id''::uuid'
  )

  UNION ALL

  SELECT
    'PERMISSIVE_POLICY_BYPASS', tenant.schema_name, tenant.table_name, NULL,
    format('additional permissive policy=%s definition=%s', policy_catalog.polname,
      pg_catalog.pg_get_expr(policy_catalog.polqual, policy_catalog.polrelid)),
    'Make the additional policy restrictive or remove it; permissive policies combine with OR.',
    NULL
  FROM tenant_relations AS tenant
  JOIN pg_catalog.pg_policy AS policy_catalog ON policy_catalog.polrelid = tenant.oid
  WHERE policy_catalog.polpermissive
    AND policy_catalog.polname <> 'tenant_isolation'
    AND NOT (
      tenant.schema_name = 'app'
      AND tenant.table_name = 'invitations'
      AND policy_catalog.polname = 'invitation_token_verification'
      AND policy_catalog.polcmd = 'r'
      AND policy_catalog.polroles = ARRAY[(
        SELECT role_catalog.oid
        FROM pg_catalog.pg_roles AS role_catalog
        WHERE role_catalog.rolname = 'studafy_admin'
      )]
      AND policy_catalog.polwithcheck IS NULL
      AND pg_catalog.translate(
        pg_catalog.replace(
          pg_catalog.pg_get_expr(policy_catalog.polqual, policy_catalog.polrelid),
          '::text',
          ''
        ),
        E' \n\t\r()',
        ''
      ) = 'token_hash=decodeNULLIFcurrent_setting''app.invitation_token_hash'',true,'''',''hex'''
    )
    -- The returning-user OAuth login seam (ST-079, migration 000034) reads the globally unique
    -- (provider, subject) pair before any tenant is known, via a SECURITY DEFINER resolver scoped to
    -- the pair placed in transaction-local GUCs. Same shape as the invitation carve-out above: a
    -- SELECT-only policy for studafy_admin with no WITH CHECK, so it cannot widen any mutation path.
    AND NOT (
      tenant.schema_name = 'app'
      AND tenant.table_name = 'oauth_identities'
      AND policy_catalog.polname = 'oauth_identity_login_lookup'
      AND policy_catalog.polcmd = 'r'
      AND policy_catalog.polroles = ARRAY[(
        SELECT role_catalog.oid
        FROM pg_catalog.pg_roles AS role_catalog
        WHERE role_catalog.rolname = 'studafy_admin'
      )]
      AND policy_catalog.polwithcheck IS NULL
      AND pg_catalog.translate(
        pg_catalog.replace(
          pg_catalog.pg_get_expr(policy_catalog.polqual, policy_catalog.polrelid),
          '::text',
          ''
        ),
        E' \n\t\r()',
        ''
      ) = 'provider=NULLIFcurrent_setting''app.oauth_login_provider'',true,''''ANDsubject=NULLIFcurrent_setting''app.oauth_login_subject'',true,'''''
    )

  UNION ALL

  SELECT
    'SCHOOL_LEADING_INDEX', tenant.schema_name, tenant.table_name, 'school_id',
    coalesce((
      SELECT string_agg(indexes.indexdef, '; ' ORDER BY indexes.indexname)
      FROM pg_catalog.pg_indexes AS indexes
      WHERE indexes.schemaname = tenant.schema_name
        AND indexes.tablename = tenant.table_name
    ), 'no indexes'),
    'Add a valid B-tree index whose first key column is school_id; specialized indexes do not satisfy the RLS path.',
    format(
      'EXPLAIN (COSTS OFF) SELECT 1 FROM %I.%I WHERE school_id = ''00000000-0000-4000-8000-000000000001''::uuid;',
      tenant.schema_name, tenant.table_name
    )
  FROM tenant_relations AS tenant
  WHERE NOT EXISTS (
    SELECT 1
    FROM index_state AS state
    WHERE state.table_oid = tenant.oid
      AND state.indisvalid
      AND state.indisready
      AND state.indnkeyatts > 0
      AND state.indexprs IS NULL
      AND state.amname = 'btree'
      AND state.first_attnum = tenant.school_attnum
  )

  UNION ALL

  SELECT
    'REDUNDANT_SCHOOL_INDEX', tenant.schema_name, tenant.table_name, 'school_id',
    format('redundant=%s', pg_catalog.pg_get_indexdef(single_index.indexrelid)),
    'Drop the plain single-column school_id index; an existing composite B-tree already covers the same prefix.',
    NULL
  FROM tenant_relations AS tenant
  JOIN index_state AS single_index
    ON single_index.table_oid = tenant.oid
   AND single_index.indisvalid
   AND single_index.indisready
   AND single_index.amname = 'btree'
   AND single_index.first_attnum = tenant.school_attnum
   AND single_index.indnkeyatts = 1
   AND NOT single_index.indisunique
   AND NOT single_index.indisprimary
   AND single_index.indpred IS NULL
   AND single_index.indexprs IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_constraint AS backing_constraint
     WHERE backing_constraint.conindid = single_index.indexrelid
   )
  WHERE EXISTS (
    SELECT 1
    FROM index_state AS composite_index
    WHERE composite_index.table_oid = tenant.oid
      AND composite_index.indisvalid
      AND composite_index.indisready
      AND composite_index.amname = 'btree'
      AND composite_index.first_attnum = tenant.school_attnum
      AND composite_index.indnkeyatts > 1
  )

  UNION ALL

  SELECT
    'TENANT_COMPOSITE_FOREIGN_KEY', child.schema_name, child.table_name, NULL,
    format('parent=%I.%I constraint=%s definition=%s validated=%s',
      parent.schema_name, parent.table_name, constraint_catalog.conname,
      pg_catalog.pg_get_constraintdef(constraint_catalog.oid), constraint_catalog.convalidated),
    'Replace the relationship with a validated composite foreign key containing school_id on both sides in the same key position.',
    NULL
  FROM pg_catalog.pg_constraint AS constraint_catalog
  JOIN tenant_relations AS child ON child.oid = constraint_catalog.conrelid
  JOIN tenant_relations AS parent ON parent.oid = constraint_catalog.confrelid
  WHERE constraint_catalog.contype = 'f'
    AND (
      NOT constraint_catalog.convalidated
      OR NOT constraint_catalog.conkey @> ARRAY[child.school_attnum]::smallint[]
      OR NOT constraint_catalog.confkey @> ARRAY[parent.school_attnum]::smallint[]
      OR pg_catalog.array_position(constraint_catalog.conkey, child.school_attnum)
         <> pg_catalog.array_position(constraint_catalog.confkey, parent.school_attnum)
    )

  UNION ALL

  SELECT
    'UNAPPROVED_FLEXIBLE_COLUMN', relation.schema_name, relation.table_name, attribute.attname,
    format('type=%s', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)),
    'Normalize relational values into constrained rows, or document and explicitly approve a genuinely flexible/external payload.',
    NULL
  FROM relations AS relation
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  JOIN pg_catalog.pg_type AS type_catalog ON type_catalog.oid = attribute.atttypid
  LEFT JOIN approved_flexible_columns AS approved
    ON approved.table_name = relation.table_name
   AND approved.column_name = attribute.attname
  WHERE NOT relation.relispartition
    AND (type_catalog.typname IN ('json', 'jsonb') OR type_catalog.typcategory = 'A')
    AND approved.table_name IS NULL
),
stats AS (
  SELECT
    (SELECT count(*)::integer FROM relations) AS app_relations,
    (SELECT count(*)::integer FROM tenant_relations) AS tenant_relations
),
report_rows AS (
  SELECT
    violation.rule_code,
    violation.schema_name,
    violation.table_name,
    violation.column_name,
    violation.catalog_state,
    violation.remediation,
    violation.diagnostic_sql,
    stats.app_relations,
    stats.tenant_relations
  FROM violations AS violation
  CROSS JOIN stats

  UNION ALL

  SELECT
    '__SUMMARY__', 'app', '', NULL, '', '', NULL,
    stats.app_relations, stats.tenant_relations
  FROM stats
)
SELECT *
FROM report_rows
ORDER BY (rule_code = '__SUMMARY__') DESC, rule_code, schema_name, table_name, column_name NULLS FIRST;
`;

const RLS_COVERAGE_EXPLAIN_QUERY = `EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ${RLS_COVERAGE_QUERY}`;

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * percentileValue) - 1]!;
}

function serverDuration(result: unknown): number {
  const plan = (result as ExplainRow[])[0]?.["QUERY PLAN"]?.[0];
  const duration =
    (plan?.["Planning Time"] ?? Number.NaN) + (plan?.["Execution Time"] ?? Number.NaN);
  if (!Number.isFinite(duration)) {
    throw new Error("RLS coverage EXPLAIN did not return planning and execution timing");
  }
  return duration;
}

export async function auditRlsCoverage(
  client: CatalogClient,
  budgetMs = RLS_COVERAGE_BUDGET_MS,
): Promise<RlsCoverageReport> {
  await client.unsafe("SELECT 1");
  // EXPLAIN ANALYZE reports PostgreSQL's own planning plus execution time. Measuring that server-side
  // duration keeps the CI budget focused on catalog work instead of host scheduler/network jitter.
  for (let iteration = 0; iteration < RLS_COVERAGE_WARMUP_COUNT; iteration += 1) {
    await client.unsafe(RLS_COVERAGE_EXPLAIN_QUERY, [], { prepare: true });
  }
  const samples: number[] = [];
  for (let iteration = 0; iteration < RLS_COVERAGE_MEASUREMENT_COUNT; iteration += 1) {
    const result = await client.unsafe(RLS_COVERAGE_EXPLAIN_QUERY, [], { prepare: true });
    samples.push(serverDuration(result));
  }
  const elapsedMs = percentile(samples, 0.95);
  const rows = (await client.unsafe(RLS_COVERAGE_QUERY, [], { prepare: true })) as CatalogRow[];
  const summary = rows.find((row) => row.rule_code === "__SUMMARY__");
  if (!summary) throw new Error("RLS coverage query did not return its summary row");

  const violations: RlsCoverageViolation[] = rows
    .filter((row) => row.rule_code !== "__SUMMARY__")
    .map((row) => ({
      ruleCode: row.rule_code,
      schemaName: row.schema_name,
      tableName: row.table_name,
      columnName: row.column_name,
      catalogState: row.catalog_state,
      remediation: row.remediation,
      diagnosticSql: row.diagnostic_sql,
    }));

  for (const violation of violations) {
    if (violation.ruleCode !== "SCHOOL_LEADING_INDEX" || !violation.diagnosticSql) continue;
    try {
      const plan = (await client.unsafe(violation.diagnosticSql)) as Record<string, unknown>[];
      violation.explainPlan = plan
        .map((row) => String(Object.values(row)[0] ?? ""))
        .filter(Boolean)
        .join("\n");
    } catch (error) {
      violation.explainPlan = `EXPLAIN unavailable: ${error instanceof Error ? error.message : "unknown error"}`;
    }
  }

  if (elapsedMs >= budgetMs) {
    violations.push({
      ruleCode: "PERFORMANCE_BUDGET",
      schemaName: "app",
      tableName: "",
      columnName: null,
      catalogState:
        `server-reported catalog audit p95 was ${roundMilliseconds(elapsedMs)}ms across ` +
        `${RLS_COVERAGE_MEASUREMENT_COUNT} measurements after ` +
        `${RLS_COVERAGE_WARMUP_COUNT} warmups; budget is < ${budgetMs}ms`,
      remediation:
        "Inspect query plans and catalog growth; keep the compliance audit below its CI budget.",
      diagnosticSql: null,
    });
  }

  return {
    compliant: violations.length === 0,
    measurementCount: RLS_COVERAGE_MEASUREMENT_COUNT,
    warmupCount: RLS_COVERAGE_WARMUP_COUNT,
    elapsedMs,
    budgetMs,
    appRelations: Number(summary.app_relations),
    tenantRelations: Number(summary.tenant_relations),
    violations,
  };
}

export function formatRlsCoverageReport(report: RlsCoverageReport): string {
  const elapsed = roundMilliseconds(report.elapsedMs);
  if (report.compliant) {
    return (
      `RLS policy coverage PASS: ${report.tenantRelations}/${report.appRelations} app relations are tenant-scoped; ` +
      `server-reported catalog audit p95 ${elapsed}ms across ${report.measurementCount} measurements ` +
      `after ${report.warmupCount} warmups (< ${report.budgetMs}ms).`
    );
  }

  const details = report.violations.map((violation, index) => {
    const relation = violation.tableName
      ? `${violation.schemaName}.${violation.tableName}${violation.columnName ? `.${violation.columnName}` : ""}`
      : violation.schemaName;
    const lines = [
      `${index + 1}. [${violation.ruleCode}] ${relation}`,
      `   Catalog: ${violation.catalogState}`,
      `   Fix: ${violation.remediation}`,
    ];
    if (violation.diagnosticSql) lines.push(`   Diagnostic: ${violation.diagnosticSql}`);
    if (violation.explainPlan) lines.push(`   EXPLAIN hazard:\n${violation.explainPlan}`);
    return lines.join("\n");
  });

  return [
    `RLS policy coverage FAIL: ${report.violations.length} violation(s); ` +
      `${report.tenantRelations}/${report.appRelations} tenant relations; server-reported catalog audit p95 ` +
      `${elapsed}ms across ${report.measurementCount} measurements after ${report.warmupCount} warmups.`,
    ...details,
  ].join("\n");
}
