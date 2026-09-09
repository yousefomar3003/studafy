/**
 * Tenant-table discovery for the GDPR pipeline (ST-268).
 *
 * "Which tables carry one school's data" is answered once, at query time, from the catalog --
 * exactly the same classification infra/tools/tenant-restore/lib/discover-tenant-tables.sql already
 * treats as ground truth for the sibling ST-267 tool (a non-dropped `school_id` column on a
 * non-partition `app` relation). A hardcoded table list would drift the moment a migration adds a
 * new tenant table and nobody remembers to update it here; this can't drift, because it IS the
 * catalog.
 *
 * Deliberately simpler than discover-tenant-tables.sql: that tool needs a topological FK order
 * because it loads/deletes rows across tables. This pipeline never deletes an arbitrary tenant
 * table's rows (see retention-registry.ts's header for why redaction replaced deletion), so there is
 * no cross-table ordering to compute -- every table is independent once its own action is decided.
 */

import type { ISql } from "postgres";

export interface TenantTable {
  tableName: string;
  isPartitioned: boolean;
}

const DISCOVER_TENANT_TABLES_SQL = `
  SELECT c.relname AS table_name, (c.relkind = 'p') AS is_partitioned
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute AS school
    ON school.attrelid = c.oid
   AND school.attname = 'school_id'
   AND school.attnum > 0
   AND NOT school.attisdropped
  WHERE n.nspname = 'app'
    AND c.relkind IN ('r', 'p')
    AND NOT c.relispartition
  ORDER BY c.relname
`;

export async function discoverTenantTables(sql: ISql): Promise<TenantTable[]> {
  const rows = await sql.unsafe<{ table_name: string; is_partitioned: boolean }[]>(
    DISCOVER_TENANT_TABLES_SQL,
  );
  return rows.map((row) => ({ tableName: row.table_name, isPartitioned: row.is_partitioned }));
}
