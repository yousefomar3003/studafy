-- Read-only psql helper for investigating an ST-050 failure. The Bun audit emits only violations;
-- this query shows the complete catalog state for every tenant relation and its partitions.
SELECT
  namespace.nspname AS schema_name,
  relation.relname AS table_name,
  relation.relkind,
  relation.relispartition,
  relation.relrowsecurity AS rls_enabled,
  relation.relforcerowsecurity AS rls_forced,
  attribute.attnotnull AS school_id_not_null,
  pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS school_id_type,
  coalesce(policy_state.policies, '[]'::jsonb) AS policies,
  coalesce(index_state.indexes, '[]'::jsonb) AS indexes,
  coalesce(constraint_state.constraints, '[]'::jsonb) AS foreign_keys
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_attribute AS attribute
  ON attribute.attrelid = relation.oid
 AND attribute.attname = 'school_id'
 AND attribute.attnum > 0
 AND NOT attribute.attisdropped
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
    jsonb_build_object(
      'name', policies.policyname,
      'permissive', policies.permissive,
      'command', policies.cmd,
      'roles', policies.roles,
      'using', policies.qual,
      'check', policies.with_check
    ) ORDER BY policies.policyname
  ) AS policies
  FROM pg_catalog.pg_policies AS policies
  WHERE policies.schemaname = namespace.nspname
    AND policies.tablename = relation.relname
) AS policy_state ON true
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
    jsonb_build_object('name', indexes.indexname, 'definition', indexes.indexdef)
    ORDER BY indexes.indexname
  ) AS indexes
  FROM pg_catalog.pg_indexes AS indexes
  WHERE indexes.schemaname = namespace.nspname
    AND indexes.tablename = relation.relname
) AS index_state ON true
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
    jsonb_build_object(
      'name', constraints.conname,
      'validated', constraints.convalidated,
      'definition', pg_catalog.pg_get_constraintdef(constraints.oid)
    ) ORDER BY constraints.conname
  ) AS constraints
  FROM pg_catalog.pg_constraint AS constraints
  WHERE constraints.conrelid = relation.oid
    AND constraints.contype = 'f'
) AS constraint_state ON true
WHERE namespace.nspname = 'app'
  AND relation.relkind IN ('r', 'p')
ORDER BY relation.relname;
