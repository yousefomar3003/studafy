-- Lets the platform console file a whole-school export for an open school (reason
-- 'platform_export', added in 000212).
--
-- 1. Reason and scope: a platform export is always tenant-wide and always an export, never an
--    erasure. The console has no way to file an erasure, and this keeps it that way at the schema.
-- 2. Requester: the operator is a user of Studafy's own school, not of the school being exported,
--    so the composite (requested_by_user_id, school_id) foreign key cannot name them. A platform
--    export therefore has no requester on the row (the operator is recorded in the audit rows the
--    console writes in both schools); every other request still must name one.
--
-- The closure sweep's "has this school already got its closure export" lookup is narrowed to
-- reason 'tenant_closure' in the same change (apps/workers closure-sweep / dsr-store), so a
-- platform export can never stand in for a closure export.

SET ROLE studafy_admin;

ALTER TABLE app.data_subject_requests
  DROP CONSTRAINT ck_data_subject_requests_reason_scope;

ALTER TABLE app.data_subject_requests
  ADD CONSTRAINT ck_data_subject_requests_reason_scope CHECK (
    (reason = 'tenant_closure' AND subject_scope = 'tenant') OR
    (reason = 'user_request' AND subject_scope = 'user') OR
    (reason = 'platform_export' AND subject_scope = 'tenant' AND request_type = 'export')
  );

ALTER TABLE app.data_subject_requests
  ALTER COLUMN requested_by_user_id DROP NOT NULL;

ALTER TABLE app.data_subject_requests
  ADD CONSTRAINT ck_data_subject_requests_requester CHECK (
    requested_by_user_id IS NOT NULL OR reason = 'platform_export'
  );

-- The console's "latest platform export of this school" read.
CREATE INDEX idx_data_subject_requests_platform_exports
  ON app.data_subject_requests (school_id, created_at DESC)
  WHERE reason = 'platform_export';

RESET ROLE;
