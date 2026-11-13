-- Creates app.security_events: the record of boundary rejections (CSRF failures, foreign-origin
-- probes) raised by the ST-067 middleware chain before a request ever reaches a route.
--
-- WHY THIS IS NOT app.audit_logs. ST-067 asked for these events to land in the partitioned audit
-- log. They cannot, and the reason is structural rather than a matter of preference:
--
--   1. app.audit_logs.school_id is NOT NULL with a foreign key to app.schools. A rejected request
--      is rejected *before* authentication, so it has no tenant. There is no value that satisfies
--      that constraint, and no honest placeholder -- inventing one would attribute an attacker's
--      probe to a real school.
--   2. app.audit_logs.target_id is NOT NULL. A refused request mutated nothing, so there is no
--      target row to name.
--   3. app.audit_logs.actor_id is a composite FK (actor_id, school_id) -> app.users, which is only
--      checkable once a tenant is known.
--
-- Relaxing school_id to make this fit would admit un-tenanted rows into a FORCE-RLS, append-only,
-- tenant-partitioned table -- dissolving the isolation guarantee NFR-05 exists to prove. So these
-- events get their own relation instead, and app.audit_logs keeps its contract intact.
--
-- THIS IS A GLOBAL TABLE, DELIBERATELY. It carries no school_id at all, and is registered in the
-- approved_globals allowlist in db/policies/rls-coverage.ts. That is the honest classification: the
-- events describe traffic that never established a tenant, so there is no tenant to isolate by. A
-- nullable school_id would be the worst of both worlds -- it would fail the coverage checker's
-- tenant-table rules and its global-table rules simultaneously, and would encode an identity the
-- middleware structurally cannot know. If per-tenant security events are wanted once a session
-- subsystem exists, they belong in a separate tenant-scoped relation, not in this one.
--
-- Depends on 000001 (app schema, studafy_app role).

SET ROLE studafy_admin;

-- The closed set of boundary rejections the middleware chain can raise. An enum rather than free
-- text for the same reason app.audit_action is one: the domain is closed and the database, not
-- convention, should enforce it. Extending it is a one-line ALTER TYPE ... ADD VALUE in a new
-- migration.
CREATE TYPE app.security_event_type AS ENUM (
  'csrf_missing_token',
  'csrf_token_mismatch',
  'cors_origin_rejected'
);

-- One boundary rejection. Every field is an atomic column: this table is written by an unauthenticated
-- code path, so there is no payload state to capture and therefore no jsonb here at all.
--
-- request_id is the join key back to the structured logs (ST-054). It is nullable rather than NOT NULL
-- because the sink must never be the reason a rejection fails to be recorded -- if requestIdMiddleware
-- has not run, or supplied a non-UUID value, the event is still worth keeping.
CREATE TABLE app.security_events (
  id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT pk_security_events PRIMARY KEY,
  event_type app.security_event_type NOT NULL,
  request_path text NOT NULL,
  request_method text NOT NULL,
  origin text,
  client_ip inet,
  user_agent text,
  request_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_security_events_path CHECK (
    request_path = btrim(request_path) AND request_path <> ''
  ),
  CONSTRAINT ck_security_events_method CHECK (
    request_method = upper(btrim(request_method)) AND request_method <> ''
  )
);

-- The two query paths this table actually serves: "what happened recently" (incident triage, and the
-- retention sweep described below) and "what has this address been doing" (probe attribution). Both
-- are time-ordered, hence DESC on created_at.
CREATE INDEX idx_security_events_created_at ON app.security_events (created_at DESC);
CREATE INDEX idx_security_events_client_ip_created_at
  ON app.security_events (client_ip, created_at DESC)
  WHERE client_ip IS NOT NULL;

-- Append-only for the runtime role, by grant. studafy_app inserts and reads; it can never rewrite
-- history. The explicit REVOKE is mandatory rather than decoration: 000002 sets ALTER DEFAULT
-- PRIVILEGES granting studafy_app SELECT/INSERT/UPDATE/DELETE on every table studafy_admin creates
-- in this schema, so a bare GRANT SELECT, INSERT would leave UPDATE and DELETE in place.
--
-- Unlike app.audit_logs this table is NOT partitioned and carries no append-only trigger. Its rows
-- are operational telemetry with a bounded useful life, not a compliance record: DELETE by
-- studafy_admin is the intended retention mechanism, so a trigger forbidding it would be actively
-- wrong here. Retention is a scheduled sweep (see docs/security/web_defense_matrix.md); the write
-- path is rate-bounded in the application by the sink's queue ceiling, so an unauthenticated caller
-- cannot drive unbounded growth.
REVOKE ALL PRIVILEGES ON TABLE app.security_events FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE app.security_events TO studafy_app;

REVOKE ALL ON TYPE app.security_event_type FROM PUBLIC;
GRANT USAGE ON TYPE app.security_event_type TO studafy_app;

RESET ROLE;
