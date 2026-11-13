-- Schema hygiene after the messaging / school-applications / member-code batch (000125-000141).
--
-- 1. app.school_applications.school_id -> provisioned_school_id
--    The table is global (000139: an application exists before its school does), but any column
--    literally named `school_id` makes the RLS coverage audit (db/policies/rls-coverage.ts), the
--    tenant export/erasure walk (apps/workers/src/queues/maintenance/tenant-tables.ts) and the
--    tenant-restore discovery (infra/tools/tenant-restore/lib/discover-tenant-tables.sql) treat it
--    as tenant data. The column is only the school an approval provisioned, so name it that. The
--    CHECK and FK constraints follow the rename automatically.
--
-- 2. app.users.search_tsv tolerates a NULL email
--    000141 made users.email nullable for member-code-only accounts. The 000110 expression
--    `coalesce(display_name, '') || ' ' || email` is NULL whenever email is NULL, so global search
--    could not find those users even by name.
--
-- 3. Tighten studafy_app privileges on append-only / no-delete tables
--    000002's default privileges grant studafy_app SELECT/INSERT/UPDATE/DELETE on every new table;
--    000129 and 000131 revoked only from PUBLIC, so the runtime role kept privileges their headers
--    say it must not have (the same gap 000134 closed for message tables).

SET ROLE studafy_admin;

-- 1 -------------------------------------------------------------------------------------------------
ALTER TABLE app.school_applications RENAME COLUMN school_id TO provisioned_school_id;
ALTER TABLE app.school_applications
  RENAME CONSTRAINT fk_school_applications_school TO fk_school_applications_provisioned_school;

-- 2 -------------------------------------------------------------------------------------------------
DROP INDEX app.idx_users_search_tsv;
ALTER TABLE app.users DROP COLUMN search_tsv;
ALTER TABLE app.users
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(display_name, '') || ' ' || coalesce(email, ''))
  ) STORED;
CREATE INDEX idx_users_search_tsv ON app.users USING gin (search_tsv);

-- 3 -------------------------------------------------------------------------------------------------
-- Refund requests are a billing record: status moves forward, rows are never deleted.
REVOKE DELETE ON TABLE app.subscription_refund_requests FROM studafy_app;
-- A revision is updated through its review lifecycle but never deleted.
REVOKE DELETE ON TABLE app.grade_revisions FROM studafy_app;
-- Revision items are the before/after snapshot of a revision: insert-only.
REVOKE UPDATE, DELETE ON TABLE app.grade_revision_items FROM studafy_app;

RESET ROLE;
