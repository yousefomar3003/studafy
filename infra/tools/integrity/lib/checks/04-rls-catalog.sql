-- integrity check (catalog sub-probe of rls-spot-probes): tenant isolation is actually installed.
--
-- Checks the spot-probe table set against the immutable catalog facts app.apply_tenant_isolation
-- (migration 000006) guarantees for every tenant table: ROW LEVEL SECURITY enabled, FORCE ROW LEVEL
-- SECURITY set, exactly one permissive tenant_isolation policy scoped TO PUBLIC whose USING/WITH
-- CHECK both normalize to school_id=current_setting('app.school_id')::uuid, and no other permissive
-- policy. The behavioural probes live in rls-spot-probes.sh (no-GUC fail-closed behaviour, wrong-GUC
-- zero rows, correct-GUC parity); this file is purely read-only catalog inspection and needs no GUC.
--
-- One JSON line on stdout. Run via:
--   psql -X -tA -v ON_ERROR_STOP=1 -f 04-rls-catalog.sql

CREATE TEMP TABLE findings (
  tbl    text NOT NULL,
  issue  text NOT NULL,
  detail text NOT NULL
);

WITH probe AS (
  SELECT 'students' AS tbl
  UNION ALL SELECT 'enrollments'
  UNION ALL SELECT 'invoice_cache'
  UNION ALL SELECT 'grades'
  UNION ALL SELECT 'gradebooks'
  UNION ALL SELECT 'grade_submissions'
),
cand AS (
  SELECT p.tbl,
         c.oid             AS relid,
         c.relrowsecurity,
         c.relforcerowsecurity
  FROM probe AS p
  JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'app'
  JOIN pg_catalog.pg_class AS c
    ON c.relname = p.tbl AND c.relnamespace = n.oid
),
pol AS (
  SELECT c.*,
         pol.polname            AS polname,
         pol.polpermissive      AS polpermissive,
         pol.polroles           AS polroles,
         pol.polcmd             AS polcmd,
         pg_catalog.pg_get_expr(pol.polqual, pol.polrelid)     AS using_expr,
         pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr
  FROM cand AS c
  LEFT JOIN pg_catalog.pg_policy AS pol
    ON pol.polrelid = c.relid AND pol.polname = 'tenant_isolation'
)
INSERT INTO findings (tbl, issue, detail)
SELECT tbl, 'row-level-security-disabled',
       format('app.%s has relrowsecurity = %s', tbl, relrowsecurity)
FROM cand
WHERE NOT relrowsecurity;

WITH probe AS (
  SELECT 'students' AS tbl
  UNION ALL SELECT 'enrollments'
  UNION ALL SELECT 'invoice_cache'
  UNION ALL SELECT 'grades'
  UNION ALL SELECT 'gradebooks'
  UNION ALL SELECT 'grade_submissions'
),
cand AS (
  SELECT p.tbl,
         c.oid             AS relid,
         c.relrowsecurity,
         c.relforcerowsecurity
  FROM probe AS p
  JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'app'
  JOIN pg_catalog.pg_class AS c
    ON c.relname = p.tbl AND c.relnamespace = n.oid
)
INSERT INTO findings (tbl, issue, detail)
SELECT tbl, 'not-forced',
       format('app.%s has relforcerowsecurity = %s (FORCE ROW LEVEL SECURITY not set)', tbl, relforcerowsecurity)
FROM cand
WHERE NOT relforcerowsecurity;

WITH probe AS (
  SELECT 'students' AS tbl
  UNION ALL SELECT 'enrollments'
  UNION ALL SELECT 'invoice_cache'
  UNION ALL SELECT 'grades'
  UNION ALL SELECT 'gradebooks'
  UNION ALL SELECT 'grade_submissions'
),
cand AS (
  SELECT p.tbl, c.oid AS relid
  FROM probe AS p
  JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'app'
  JOIN pg_catalog.pg_class AS c
    ON c.relname = p.tbl AND c.relnamespace = n.oid
)
INSERT INTO findings (tbl, issue, detail)
SELECT t.tbl, 'policy-missing',
       format('app.%s has no tenant_isolation policy', t.tbl)
FROM (SELECT tbl, relid FROM cand) AS t
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_policy AS pol
  WHERE pol.polrelid = t.relid AND pol.polname = 'tenant_isolation'
);

WITH probe AS (
  SELECT 'students' AS tbl
  UNION ALL SELECT 'enrollments'
  UNION ALL SELECT 'invoice_cache'
  UNION ALL SELECT 'grades'
  UNION ALL SELECT 'gradebooks'
  UNION ALL SELECT 'grade_submissions'
),
cand AS (
  SELECT p.tbl,
         c.oid AS relid
  FROM probe AS p
  JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'app'
  JOIN pg_catalog.pg_class AS c
    ON c.relname = p.tbl AND c.relnamespace = n.oid
),
pol AS (
  SELECT c.*, pol.polpermissive AS polpermissive, pol.polroles AS polroles, pol.polcmd AS polcmd
  FROM cand AS c
  JOIN pg_catalog.pg_policy AS pol
    ON pol.polrelid = c.relid AND pol.polname = 'tenant_isolation'
)
INSERT INTO findings (tbl, issue, detail)
SELECT tbl, 'policy-not-canonical', format(
  'tenant_isolation on app.%s is permissive=%s roles=%s cmd=%s (expected permissive + PUBLIC + FOR ALL)',
  tbl, polpermissive, polroles, polcmd)
FROM pol
WHERE NOT polpermissive OR polroles <> ARRAY[0]::oid[] OR polcmd <> '*';

WITH probe AS (
  SELECT 'students' AS tbl
  UNION ALL SELECT 'enrollments'
  UNION ALL SELECT 'invoice_cache'
  UNION ALL SELECT 'grades'
  UNION ALL SELECT 'gradebooks'
  UNION ALL SELECT 'grade_submissions'
),
cand AS (
  SELECT p.tbl, c.oid AS relid
  FROM probe AS p
  JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'app'
  JOIN pg_catalog.pg_class AS c
    ON c.relname = p.tbl AND c.relnamespace = n.oid
),
pol AS (
  SELECT c.*,
         pg_catalog.pg_get_expr(pol.polqual, pol.polrelid)      AS using_expr,
         pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr
  FROM cand AS c
  JOIN pg_catalog.pg_policy AS pol
    ON pol.polrelid = c.relid AND pol.polname = 'tenant_isolation'
)
INSERT INTO findings (tbl, issue, detail)
SELECT tbl, 'policy-using-mismatch', format(
  'tenant_isolation USING on app.%s is %s, expected school_id=current_setting(''app.school_id'')::uuid',
  tbl, using_expr)
FROM pol
WHERE regexp_replace(replace(using_expr, '::text', ''), '[[:space:]()]', '', 'g')
      <> 'school_id=current_setting''app.school_id''::uuid';

WITH probe AS (
  SELECT 'students' AS tbl
  UNION ALL SELECT 'enrollments'
  UNION ALL SELECT 'invoice_cache'
  UNION ALL SELECT 'grades'
  UNION ALL SELECT 'gradebooks'
  UNION ALL SELECT 'grade_submissions'
),
cand AS (
  SELECT p.tbl, c.oid AS relid
  FROM probe AS p
  JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'app'
  JOIN pg_catalog.pg_class AS c
    ON c.relname = p.tbl AND c.relnamespace = n.oid
),
pol AS (
  SELECT c.*,
         pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr
  FROM cand AS c
  JOIN pg_catalog.pg_policy AS pol
    ON pol.polrelid = c.relid AND pol.polname = 'tenant_isolation'
)
INSERT INTO findings (tbl, issue, detail)
SELECT tbl, 'policy-check-mismatch', format(
  'tenant_isolation WITH CHECK on app.%s is %s, expected school_id=current_setting(''app.school_id'')::uuid',
  tbl, check_expr)
FROM pol
WHERE regexp_replace(replace(check_expr, '::text', ''), '[[:space:]()]', '', 'g')
      <> 'school_id=current_setting''app.school_id''::uuid';

-- A second permissive policy would broaden tenant access (apply_tenant_isolation rejects exactly
-- this when (re)applying isolation), so it is a real defect even though restrictive
-- role_scope_visibility policies are legitimately layered on top for students-facing reads.
WITH probe AS (
  SELECT 'students' AS tbl
  UNION ALL SELECT 'enrollments'
  UNION ALL SELECT 'invoice_cache'
  UNION ALL SELECT 'grades'
  UNION ALL SELECT 'gradebooks'
  UNION ALL SELECT 'grade_submissions'
),
cand AS (
  SELECT p.tbl, c.oid AS relid
  FROM probe AS p
  JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'app'
  JOIN pg_catalog.pg_class AS c
    ON c.relname = p.tbl AND c.relnamespace = n.oid
)
INSERT INTO findings (tbl, issue, detail)
SELECT t.tbl, 'extra-permissive-policy', format(
  'app.%s has an additional permissive policy %s beyond tenant_isolation',
  t.tbl, pol.polname)
FROM (SELECT tbl, relid FROM cand) AS t
JOIN pg_catalog.pg_policy AS pol
  ON pol.polrelid = t.relid
 AND pol.polname <> 'tenant_isolation'
 AND pol.polpermissive;

SELECT json_build_object(
  'status', CASE WHEN (SELECT count(*) FROM findings) = 0 THEN 'pass' ELSE 'fail' END,
  'findings_count', (SELECT count(*) FROM findings),
  'findings', COALESCE((
    SELECT json_agg(json_build_object('table', tbl, 'issue', issue, 'detail', detail)
      ORDER BY tbl, issue)
    FROM (SELECT * FROM findings ORDER BY tbl LIMIT 100) f
  ), '[]'::json),
  'summary', (SELECT
    CASE WHEN (SELECT count(*) FROM findings) = 0
      THEN 'catalog: all 6 spot-probe tables have RLS enabled, forced, and the canonical tenant_isolation policy, with no extra permissive policy'
      ELSE (SELECT 'catalog: ' || count(*) || ' defect(s) in tenant isolation installation' FROM findings)
    END
  )
);