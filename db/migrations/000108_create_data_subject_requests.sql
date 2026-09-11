-- Data subject request lifecycle (ST-268): the durable record behind both halves of the GDPR
-- pipeline apps/workers/src/queues/maintenance implements.
--
-- One table, two shapes of request, distinguished by `subject_scope`:
--   'tenant' -- the whole school, `reason = 'tenant_closure'`, `subject_user_id` NULL. Produced
--              automatically by the closure sweep once app.subscriptions.status reaches 'closed'
--              (packages/billing's state machine, docs/database/subscriptions-data-model.md).
--   'user'   -- one person, `reason = 'user_request'`, `subject_user_id` set. Filed through
--              apps/api's privacy module by an ORG_ADMIN/SUPER_ADMIN acting on a request from the
--              subject (GDPR Art. 15/17), while the tenant is still active.
--
-- `request_type` ('export'|'erasure') is orthogonal to scope: a closure files one export row and,
-- once its retention hold elapses, one erasure row; a user request is whichever the requester asked
-- for. Reusing one table rather than two (mirroring app.audit_export_jobs, 000098) is what lets the
-- closure sweep and the DSR API share one claim/complete/fail lifecycle and one queue -- the two
-- kinds of request differ in *scope*, not in *how they are processed*.
--
-- `storage_key` only ever holds a value for a completed export: erasure has no artifact -- what it
-- did is recorded in `redacted_tables`/`retained_tables` instead, mirroring how a receipt describes
-- an action rather than producing a downloadable file.

SET ROLE studafy_admin;

CREATE TYPE app.dsr_request_type AS ENUM ('export', 'erasure');
CREATE TYPE app.dsr_subject_scope AS ENUM ('tenant', 'user');
CREATE TYPE app.dsr_reason AS ENUM ('tenant_closure', 'user_request');
CREATE TYPE app.dsr_status AS ENUM ('queued', 'processing', 'completed', 'failed');

CREATE TABLE app.data_subject_requests (
  id                    uuid DEFAULT gen_random_uuid() CONSTRAINT pk_data_subject_requests PRIMARY KEY,
  school_id             uuid NOT NULL,
  request_type          app.dsr_request_type NOT NULL,
  subject_scope         app.dsr_subject_scope NOT NULL,
  reason                app.dsr_reason NOT NULL,
  subject_user_id       uuid,
  requested_by_user_id  uuid NOT NULL,
  status                app.dsr_status NOT NULL DEFAULT 'queued',
  storage_key           text,
  -- Erasure outcome detail: one entry per table actually touched, e.g.
  -- [{"table": "assignment_submissions", "action": "redacted", "columns": ["submitted_by_name"], "rows": 12}].
  -- Always '[]' for an 'export' request -- export has its own manifest object in S3 (schema-verified
  -- by tenant-export.worker.ts before upload), not a second copy of the same fact here.
  redacted_tables       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Tables an erasure pass deliberately left untouched under legal hold, e.g.
  -- [{"table": "billing_events", "reason": "financial retention"}]. See retention-registry.ts.
  retained_tables       jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_message       text,
  -- GDPR Art. 12(3)'s one-month response deadline, extendable to three for complex requests -- this
  -- schema stores the baseline so `isWithinSla` (dsr-sla.ts) has a fixed target to check completion
  -- against; extending it for a specific request is an UPDATE, not a code change.
  sla_due_at            timestamptz(3) NOT NULL,
  created_at            timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at            timestamptz(3),
  completed_at          timestamptz(3),
  updated_at            timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_data_subject_requests_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_data_subject_requests_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_data_subject_requests_subject
    FOREIGN KEY (subject_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_data_subject_requests_requester
    FOREIGN KEY (requested_by_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  -- Scope and subject agree: a tenant-wide request names no one; a user request names someone.
  CONSTRAINT ck_data_subject_requests_scope_subject CHECK (
    (subject_scope = 'tenant' AND subject_user_id IS NULL) OR
    (subject_scope = 'user' AND subject_user_id IS NOT NULL)
  ),
  -- Reason and scope agree: closure is always tenant-wide, a filed request is always about one
  -- person. Collapsing these into a single column would lose the room for a future third reason
  -- (e.g. a regulator order) without implying a scope it doesn't have.
  CONSTRAINT ck_data_subject_requests_reason_scope CHECK (
    (reason = 'tenant_closure' AND subject_scope = 'tenant') OR
    (reason = 'user_request' AND subject_scope = 'user')
  ),
  -- Erasure never produces a downloadable artifact, whatever its status.
  CONSTRAINT ck_data_subject_requests_erasure_no_key CHECK (
    request_type = 'export' OR storage_key IS NULL
  ),
  CONSTRAINT ck_data_subject_requests_redacted_array CHECK (
    jsonb_typeof(redacted_tables) = 'array'
  ),
  CONSTRAINT ck_data_subject_requests_retained_array CHECK (
    jsonb_typeof(retained_tables) = 'array'
  ),
  CONSTRAINT ck_data_subject_requests_failure_message CHECK (
    failure_message IS NULL OR
      (failure_message = btrim(failure_message) AND failure_message <> '' AND length(failure_message) <= 1000)
  ),
  -- Mirrors app.audit_export_jobs' ck_..._terminal_state (000098): the three reachable shapes of a
  -- row, so a partial write (e.g. 'completed' with no completed_at) is a constraint violation, not a
  -- bug an API client discovers later.
  CONSTRAINT ck_data_subject_requests_terminal_state CHECK (
    (status IN ('queued', 'processing')
      AND storage_key IS NULL AND failure_message IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed'
      AND failure_message IS NULL AND completed_at IS NOT NULL
      AND (request_type = 'erasure' OR storage_key IS NOT NULL))
    OR
    (status = 'failed'
      AND storage_key IS NULL AND failure_message IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT ck_data_subject_requests_timestamps CHECK (
    updated_at >= created_at
    AND sla_due_at >= created_at
    AND (started_at IS NULL OR started_at >= created_at)
    AND (completed_at IS NULL OR completed_at >= created_at)
  )
);

-- Queue-claim lookup: the closure sweep and the DSR API both ask "is there already a queued/
-- processing request for this school", and the worker claims by (school_id, id).
CREATE INDEX idx_data_subject_requests_queue
  ON app.data_subject_requests (school_id, status, created_at)
  WHERE status IN ('queued', 'processing');

-- The closure sweep's own idempotency check: "does this school already have a tenant-closure
-- export/erasure row" (of any status -- it must not queue a second one while the first is still
-- live, and must not requeue once one exists at all, whatever became of it).
CREATE INDEX idx_data_subject_requests_tenant_closure
  ON app.data_subject_requests (school_id, request_type, created_at DESC)
  WHERE subject_scope = 'tenant';

-- A user's own DSR history, and the API's "one open request per person" guard.
CREATE INDEX idx_data_subject_requests_subject
  ON app.data_subject_requests (school_id, subject_user_id, created_at DESC)
  WHERE subject_user_id IS NOT NULL;

REVOKE ALL PRIVILEGES ON TABLE app.data_subject_requests FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE app.data_subject_requests TO studafy_app;

REVOKE ALL ON TYPE app.dsr_request_type FROM PUBLIC;
GRANT USAGE ON TYPE app.dsr_request_type TO studafy_app;
REVOKE ALL ON TYPE app.dsr_subject_scope FROM PUBLIC;
GRANT USAGE ON TYPE app.dsr_subject_scope TO studafy_app;
REVOKE ALL ON TYPE app.dsr_reason FROM PUBLIC;
GRANT USAGE ON TYPE app.dsr_reason TO studafy_app;
REVOKE ALL ON TYPE app.dsr_status FROM PUBLIC;
GRANT USAGE ON TYPE app.dsr_status TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'data_subject_requests');

COMMENT ON TABLE app.data_subject_requests IS
  'GDPR export/erasure request lifecycle (ST-268): tenant-closure sweeps and per-user DSR filings share this table and the maintenance queue that drains it.';

RESET ROLE;
