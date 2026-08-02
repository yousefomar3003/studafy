-- Durable entitlement version counters (ST-133).
--
-- One monotonic counter per entitlement subject. The access token's `entitlements_ver` claim is a
-- snapshot of the school's counter at mint time, and jwtAuthMiddleware rejects a token whose
-- snapshot is below the current value. That is what turns a Stripe cancellation into a sub-5-second
-- loss of access instead of one bounded by JWT_ACCESS_TTL_SECONDS.
--
-- Until now the claim was hardcoded to 1 at both signing sites (session-service.ts issueTokenPair
-- and rotateRefreshToken), a gap docs/architecture/SAD_13_session_model.md records explicitly. That
-- matters because middleware/tenant-lifecycle.ts enforces the entire subscription lifecycle state
-- machine off the token's `subscription_status` claim with, by design, zero DB calls per request --
-- so a canceled school kept full access for up to 15 minutes.
--
-- ## Why the counter cannot live in Redis
--
-- A cache flush would silently reset every counter to its genesis value and re-validate every stale
-- token in the system -- the failure mode is invisible, and it fails open. Redis still front-runs
-- this table on the read path (the ent:{schoolId} cache entry carries the version), but Postgres is
-- the source of truth and a cache miss re-reads it here.
--
-- ## Why school_id, when ST-133's column list is only (subject_type, subject_id)
--
-- app.apply_tenant_isolation requires a NOT NULL school_id with a single-column FK to
-- app.schools(id), and db/policies/rls-coverage.ts fails CI with UNCLASSIFIED_TABLE for an app
-- relation that has neither that nor an approved-global registration.
--
-- The global route was considered and rejected. Following app.billing_events (000016:133-146,
-- 000078:60-72) means revoking every privilege from studafy_app -- but this table is read at token
-- signing, inside withTenantTx, which runs as studafy_app. That would force a SECURITY DEFINER
-- reader, and every reader of this table already knows its school (the signer from its tenant
-- transaction, the JWT middleware from the verified school_id claim, the pub/sub subscriber from
-- the channel name, the invalidator from its own claim scope), so paying for a resolver seam buys
-- nothing. Carrying school_id instead makes this an ordinary tenant table: the canonical ST-034
-- policy applies, rls-coverage covers it automatically, and future drift fails CI.
--
-- ST-133's uniqueness requirement survives verbatim as uq_entitlement_versions_subject.
--
-- ## Version 1 is the absence of a row
--
-- No row means version 1; the first bump writes 2. That is why the upsert's INSERT arm is 2 and why
-- ck_entitlement_versions_version asserts >= 2. It also means the pre-ST-133 hardcoded 1 in every
-- outstanding token, and in the test harness's mintTestToken, is already the correct genesis value:
-- no backfill, no test churn, no forced re-login on deploy, and the first real bump correctly
-- invalidates them. The comparison in jwtAuth.ts is strictly-less-than, never inequality, for the
-- same reason.
--
-- ## subject_id carries no foreign key
--
-- It is polymorphic: a school id when subject_type = 'school', a student id when 'ai'. This is the
-- same correlation-handle trade app.billing_events.subscription_id documents (000078). What IS
-- asserted is that a 'school' subject names its own tenant, via ck_entitlement_versions_school_subject.
--
-- This table stores only the counter. Whether a subscription is active lives on app.subscriptions
-- and app.ai_subscriptions and is deliberately not duplicated here: those tables remain the single
-- source of truth for entitlement state, this one for staleness detection, and a bug in either
-- cannot silently corrupt the other.
--
-- ## Also here: the entitlement consumer's outbox cursor
--
-- app.outbox_events gains entitlement_applied_at, a third independent consumer cursor beside
-- relayed_at (000022) and email_dispatched_at (000077), so the invalidator, the relay and the email
-- dispatcher never block or double-consume each other. Its partial index names the two event names
-- explicitly, so the index stays proportional to the unresolved entitlement tail rather than to the
-- whole outbox -- narrower than 000077's `WHERE email_dispatched_at IS NULL`, which covers every row
-- in the table. Adding a third entitlement event therefore needs a migration; that is the deliberate
-- cost of the narrower index.
--
-- ## Indexing
--
-- The primary key covers both access patterns this table has: the point read on entitlement
-- resolution and the point read-then-increment on invalidation. No secondary index is added. An
-- index on updated_at was considered for staleness/backfill monitoring and rejected as speculative:
-- no query needs it today, and every row here is rewritten on every subscription change, so an
-- unused index is pure write amplification on the hot path.
--
-- What deliberately is NOT here: any usage counter or quota decrement (ST-155), any grace/dunning
-- state transition (ST-134), and any plan-tier quota table -- app.plans is metadata only and
-- app.subscriptions.student_cap is the single ceiling this schema has.
--
-- Depends on 000004 (app.schools), 000006/000025 (app.apply_tenant_isolation), 000022 (outbox).

SET LOCAL ROLE studafy_admin;

CREATE TYPE app.entitlement_subject AS ENUM ('school', 'ai');

CREATE TABLE app.entitlement_versions (
  school_id uuid NOT NULL,
  subject_type app.entitlement_subject NOT NULL,
  subject_id uuid NOT NULL,
  version bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_entitlement_versions PRIMARY KEY (school_id, subject_type, subject_id),
  -- ST-133's stated primary key. Kept as a unique constraint so a student id can never be claimed by
  -- two schools, which the school-leading PK alone would permit.
  CONSTRAINT uq_entitlement_versions_subject UNIQUE (subject_type, subject_id),
  CONSTRAINT fk_entitlement_versions_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- 2, not 0: an absent row is version 1, so the first persisted value is the first bump. See the
  -- header.
  CONSTRAINT ck_entitlement_versions_version CHECK (version >= 2),
  CONSTRAINT ck_entitlement_versions_school_subject CHECK (
    subject_type <> 'school' OR subject_id = school_id
  )
);

ALTER TABLE app.outbox_events
  ADD COLUMN entitlement_applied_at timestamptz;

ALTER TABLE app.outbox_events
  ADD CONSTRAINT ck_outbox_events_entitlement_applied_at
  CHECK (entitlement_applied_at IS NULL OR entitlement_applied_at >= created_at);

-- The entitlement invalidator's claim path. Sibling to idx_outbox_events_school_unrelayed and
-- idx_outbox_events_school_email_pending: same ordering, narrower predicate. The invalidator's claim
-- query must repeat this predicate verbatim -- including both event names -- or the planner will not
-- use the index.
CREATE INDEX idx_outbox_events_school_entitlement_pending
  ON app.outbox_events (school_id, id)
  WHERE entitlement_applied_at IS NULL
    AND event_name IN ('subscription.statusChanged', 'aiSubscription.statusChanged');

REVOKE ALL PRIVILEGES ON TABLE app.entitlement_versions FROM PUBLIC;
-- Mandatory, not decoration: 000002's ALTER DEFAULT PRIVILEGES has already granted studafy_app
-- SELECT/INSERT/UPDATE/DELETE on this table by the time this line runs, so a bare GRANT below would
-- leave DELETE in place.
--
-- UPDATE is granted and is load-bearing -- INSERT ... ON CONFLICT DO UPDATE is the increment. There
-- is no blanket "no UPDATE grants" convention in this schema (000016 grants full CRUD on
-- app.subscriptions, 000077 grants SELECT/INSERT/UPDATE on app.email_deliveries); the append-only
-- posture of 000018 is specific to the audit log.
--
-- DELETE is taken back and stays back: deleting a row resets the counter to the implicit genesis 1,
-- which would silently re-validate every stale token in that school. A monotonic counter used for
-- staleness detection must not be able to move backwards.
REVOKE ALL PRIVILEGES ON TABLE app.entitlement_versions FROM studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.entitlement_versions TO studafy_app;

REVOKE ALL ON TYPE app.entitlement_subject FROM PUBLIC;
GRANT USAGE ON TYPE app.entitlement_subject TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'entitlement_versions');

COMMENT ON TABLE app.entitlement_versions IS
  'Monotonic entitlement version counters, one per subject. Source of truth for JWT staleness detection; entitlement state itself lives on subscriptions/ai_subscriptions.';
COMMENT ON COLUMN app.entitlement_versions.subject_id IS
  'Polymorphic: school_id when subject_type = school, student_id when ai. Deliberately carries no foreign key.';
COMMENT ON COLUMN app.entitlement_versions.version IS
  'Monotonic counter. An absent row is version 1 (genesis); the first bump writes 2. Compared with <, never =.';
COMMENT ON COLUMN app.outbox_events.entitlement_applied_at IS
  'The entitlement invalidator''s cursor. Independent of relayed_at and email_dispatched_at.';

RESET ROLE;
