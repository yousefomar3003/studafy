-- S-01 / QA-16: what can the runtime database login do? Read-only; writes nothing, reads no personal
-- data (row counts only). Run it as the login the API and workers use through PgBouncer (the RDS
-- master user today, infra/terraform/modules/pgbouncer/README.md). Steps and how to read the output:
-- docs/security/S-01-database-role-verification.md.
--
--   psql "host=<host> port=<port> dbname=<db> user=<runtime login> sslmode=require" -f s01-db-role-audit.sql

BEGIN READ ONLY;

\echo '== 1. Who is connected'
SELECT current_user, session_user, version();

\echo '== 2. Role attributes'
SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin
FROM pg_roles
WHERE rolname IN (current_user, 'studafy_app', 'studafy_admin', 'rds_superuser')
ORDER BY rolname;

\echo '== 3. Direct role memberships of the login'
SELECT granted.rolname AS member_of, m.admin_option, m.inherit_option, m.set_option
FROM pg_auth_members AS m
JOIN pg_roles AS granted ON granted.oid = m.roleid
WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
ORDER BY 1;

\echo '== 4. Every role the login holds, directly or through another'
SELECT rolname, rolbypassrls
FROM pg_roles
WHERE pg_has_role(current_user, oid, 'MEMBER') AND rolname <> current_user
ORDER BY 1;

\echo '== 5. RLS on a tenant table, and who owns it'
SELECT relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) AS owner
FROM pg_class
WHERE oid IN ('app.users'::regclass, 'app.subscriptions'::regclass);

\echo '== 6. The live test: rows visible as the bare login, no role and no school set'
\echo '   0 = RLS applies to the login. More than 0 = the login bypasses RLS (S-01 confirmed).'
SELECT
  (SELECT count(*) FROM app.users) AS users_visible_unscoped,
  (SELECT count(*) FROM app.subscriptions) AS subscriptions_visible_unscoped,
  (SELECT count(DISTINCT school_id) FROM app.users) AS schools_seen_in_users;

ROLLBACK;
