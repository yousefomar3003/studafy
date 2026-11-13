-- integrity check: orphaned-links
--
-- Finds rows whose references point at nothing (or at another tenant), for this one school:
--   1. A catalog-driven scan of every FOREIGN KEY whose child is an app.schema table that carries a
--      school_id column. Because this schema's FKs are composite (referenced UNIQUEs always include
--      id, and when the target is a tenant table they include school_id), a row whose reference is
--      missing OR belongs to a different school fails the join and is reported. A validated FK can
--      only be violated if enforcement was bypassed (e.g. session_replication_role = replica writes,
--      which is exactly what drill-corruption.sh does), which is why validated and NOT VALID
--      (convalidated = false) constraints are scanned alike -- each finding records which it was.
--   2. The app.erpnext_id_mappings crosswalk: a mapping whose erpnext_docname is set (ERPNext has
--      confirmed the document) but whose target cache row (invoice_cache/payment_cache/
--      fee_schedule_cache, dispatched by entity) no longer exists. docname IS NULL rows are
--      reservations that legitimately exist before ERPNext confirms anything (migration 000015), so
--      they are never findings.
--
-- One JSON line on stdout. Run via:
--   psql -X -tA -v ON_ERROR_STOP=1 -v school_id=<uuid> -f 01-orphaned-links.sql
-- The first statement prints set_config's return value; consume only the last output line.

SELECT set_config('app.school_id', :'school_id', false);

CREATE TEMP TABLE findings (
  child_table   text NOT NULL,
  child_id      text NOT NULL,
  ref_table     text NOT NULL,
  fk_name       text NOT NULL,
  convalidated  boolean,
  detail        text NOT NULL
);

DO $scan$
DECLARE
  r                 record;
  i                 int;
  child_col         text;
  ref_col           text;
  first_ref_col     text;
  join_parts        text[] := ARRAY[]::text[];
  notnull_parts     text[] := ARRAY[]::text[];
  has_id            boolean;
  id_expr           text;
  q                 text;
BEGIN
  FOR r IN
    SELECT con.oid          AS con_oid,
           con.conname      AS fk_name,
           con.convalidated AS convalidated,
           con.conkey,
           con.confkey,
           n_child.nspname  AS child_schema,
           c_child.relname  AS child_table,
           c_child.oid      AS child_oid,
           n_ref.nspname    AS ref_schema,
           c_ref.relname    AS ref_table,
           c_ref.oid        AS ref_oid
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c_child ON c_child.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n_child ON n_child.oid = c_child.relnamespace
    JOIN pg_catalog.pg_class c_ref ON c_ref.oid = con.confrelid
    JOIN pg_catalog.pg_namespace n_ref ON n_ref.oid = c_ref.relnamespace
    WHERE con.contype = 'f'
      AND n_child.nspname = 'app'
      AND n_ref.nspname = 'app'
      AND c_child.relkind = 'r'
      AND NOT c_child.relispartition
      AND c_ref.relkind <> 'p'
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = c_child.oid
          AND a.attname = 'school_id'
          AND a.attnum > 0
          AND NOT a.attisdropped
      )
    ORDER BY c_child.relname, con.conname
  LOOP
    join_parts    := ARRAY[]::text[];
    notnull_parts := ARRAY[]::text[];
    first_ref_col := NULL;

    FOR i IN 1..cardinality(r.conkey) LOOP
      SELECT a.attname INTO child_col
      FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = r.child_oid
        AND a.attnum = r.conkey[i]
        AND a.attnum > 0
        AND NOT a.attisdropped;

      SELECT a.attname INTO ref_col
      FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = r.ref_oid
        AND a.attnum = r.confkey[i]
        AND a.attnum > 0
        AND NOT a.attisdropped;

      join_parts    := join_parts || format('child.%I = ref.%I', child_col, ref_col);
      notnull_parts := notnull_parts || format('child.%I IS NOT NULL', child_col);
      IF first_ref_col IS NULL THEN
        first_ref_col := ref_col;
      END IF;
    END LOOP;

    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = r.child_oid
        AND a.attname = 'id'
        AND a.attnum > 0
        AND NOT a.attisdropped
    ) INTO has_id;

    IF has_id THEN
      id_expr := format('child.%I::text', 'id');
    ELSE
      id_expr := 'to_jsonb(child)::text';
    END IF;

    q := format($q$
      INSERT INTO findings (child_table, child_id, ref_table, fk_name, convalidated, detail)
      SELECT %L,
             %s,
             %L,
             %L,
             %s,
             %L
      FROM %I.%I AS child
      LEFT JOIN %I.%I AS ref ON (%s)
      WHERE child.school_id = current_setting('app.school_id')::uuid
        AND %s
        AND ref.%I IS NULL
    $q$,
      r.child_table,
      id_expr,
      r.ref_table,
      r.fk_name,
      CASE WHEN r.convalidated THEN 'true' ELSE 'false' END,
      format(
        'row in %I.%I violates foreign key %I (referenced %I row missing or cross-tenant)',
        r.child_schema, r.child_table, r.fk_name, r.ref_table
      ),
      r.child_schema, r.child_table,
      r.ref_schema, r.ref_table,
      array_to_string(join_parts, ' AND '),
      array_to_string(notnull_parts, ' AND '),
      first_ref_col
    );
    EXECUTE q;
  END LOOP;
END
$scan$;

INSERT INTO findings (child_table, child_id, ref_table, fk_name, convalidated, detail)
SELECT 'erpnext_id_mappings' AS child_table,
       m.id::text             AS child_id,
       'invoice_cache'        AS ref_table,
       'crosswalk-invoice'    AS fk_name,
       true AS convalidated,
       format(
         'mapping entity=invoice studafy_id=%s has confirmed erpnext_docname %s but no invoice_cache row',
         m.studafy_id, m.erpnext_docname
       ) AS detail
FROM app.erpnext_id_mappings AS m
LEFT JOIN app.invoice_cache AS c
  ON c.id = m.studafy_id AND c.school_id = m.school_id
WHERE m.school_id = current_setting('app.school_id')::uuid
  AND m.entity = 'invoice'
  AND m.erpnext_docname IS NOT NULL
  AND c.id IS NULL;

INSERT INTO findings (child_table, child_id, ref_table, fk_name, convalidated, detail)
SELECT 'erpnext_id_mappings' AS child_table,
       m.id::text             AS child_id,
       'payment_cache'        AS ref_table,
       'crosswalk-payment'    AS fk_name,
       true AS convalidated,
       format(
         'mapping entity=payment studafy_id=%s has confirmed erpnext_docname %s but no payment_cache row',
         m.studafy_id, m.erpnext_docname
       ) AS detail
FROM app.erpnext_id_mappings AS m
LEFT JOIN app.payment_cache AS c
  ON c.id = m.studafy_id AND c.school_id = m.school_id
WHERE m.school_id = current_setting('app.school_id')::uuid
  AND m.entity = 'payment'
  AND m.erpnext_docname IS NOT NULL
  AND c.id IS NULL;

INSERT INTO findings (child_table, child_id, ref_table, fk_name, convalidated, detail)
SELECT 'erpnext_id_mappings' AS child_table,
       m.id::text             AS child_id,
       'fee_schedule_cache'   AS ref_table,
       'crosswalk-fee_schedule' AS fk_name,
       true AS convalidated,
       format(
         'mapping entity=fee_schedule studafy_id=%s has confirmed erpnext_docname %s but no fee_schedule_cache row',
         m.studafy_id, m.erpnext_docname
       ) AS detail
FROM app.erpnext_id_mappings AS m
LEFT JOIN app.fee_schedule_cache AS c
  ON c.id = m.studafy_id AND c.school_id = m.school_id
WHERE m.school_id = current_setting('app.school_id')::uuid
  AND m.entity = 'fee_schedule'
  AND m.erpnext_docname IS NOT NULL
  AND c.id IS NULL;

SELECT json_build_object(
  'check', 'orphaned-links',
  'status', CASE WHEN (SELECT count(*) FROM findings) = 0 THEN 'pass' ELSE 'fail' END,
  'findings_count', (SELECT count(*) FROM findings),
  'findings', COALESCE((
    SELECT json_agg(json_build_object(
      'child_table', child_table,
      'child_id', child_id,
      'ref_table', ref_table,
      'fk_name', fk_name,
      'convalidated', convalidated,
      'detail', detail
    ) ORDER BY child_table, child_id, fk_name)
    FROM (SELECT * FROM findings ORDER BY child_table, child_id LIMIT 100) f
  ), '[]'::json),
  'summary', (SELECT
    CASE WHEN (SELECT count(*) FROM findings) = 0
      THEN 'no orphaned links across ' || (SELECT count(*) FROM pg_catalog.pg_constraint WHERE contype = 'f' AND conrelid IN (
             SELECT c.oid FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
             WHERE n.nspname = 'app' AND c.relkind = 'r' AND a.attname = 'school_id' AND NOT a.attisdropped
           )) || ' tenant-scoped foreign keys'
      ELSE (SELECT
        'found ' || count(*) || ' orphaned linked row(s) across ' || count(DISTINCT child_table) || ' table(s)'
        FROM findings)
    END
  )
);