-- Makes app.refresh_tokens usable as the session record for ST-071 (refresh token issuance and
-- rotation). The table itself was created by 000007 with the rotation-family model already in
-- place -- token_hash, family_id, parent_token_id, replaced_by_token_id and the device metadata
-- columns all predate this migration. What was missing is everything the *runtime* needs, which is
-- what this adds: a link to the tracked device, the client surface the session was established from,
-- a per-user fence, and the two indexes the enumeration queries need.
--
-- Depends on 000004 (app.schools), 000007 (app.refresh_tokens), 000014 (app.current_user_id),
-- 000017 (app.user_devices).
--
--
-- HOW AN UNAUTHENTICATED REFRESH REQUEST FINDS ITS TENANT.
--
-- A refresh request arrives carrying nothing but a token. It has no access token, so there is no
-- verified school_id, and src/db/tenant-tx.ts cannot open a transaction without one: every policy
-- created by 000006 compares rows against current_setting('app.school_id') with no missing_ok, so an
-- unset GUC raises rather than matching. The restrictive policy added at the bottom of this file
-- makes the same true of app.user_id. Both identifiers therefore have to be known *before* the row
-- that holds them can be read.
--
-- The answer is to put them in the token: the wire format is `<school_uuid>.<user_uuid>.<secret>`,
-- and only the secret is hashed into token_hash. See modules/auth/tokens/opaque-token.ts.
--
-- Two designs were tried first and are recorded here so they are not attempted again:
--
--   1. A SECURITY DEFINER function reading app.refresh_tokens. This cannot work.
--      app.apply_tenant_isolation creates tenant_isolation as PERMISSIVE FOR ALL TO PUBLIC *and*
--      applies FORCE ROW LEVEL SECURITY, so the owning role is subject to the policy too, and this
--      schema deliberately has no BYPASSRLS role (000002 refuses to proceed if either role carries
--      the attribute; packages/db/tests/rls.test.ts asserts it stays false). The function would be
--      filtered by the same unset GUC and fail closed.
--
--   2. A separate global directory mapping an opaque locator to (school_id, user_id), so the token
--      would carry no tenant identifier. This is the shape 000028 used for app.security_events, and
--      it does not transfer: security_events carries no school_id at all, whereas a directory whose
--      whole purpose is to *return* one must. db/policies/rls-coverage.ts rejects exactly that
--      combination -- GLOBAL_SCOPE_DRIFT, "approved global table unexpectedly contains school_id" --
--      and 000028's own header names it in advance as "the worst of both worlds". A table in this
--      schema either carries school_id and is tenant-isolated, or carries none and is global. There
--      is no third category, and inventing one for this feature would weaken the invariant that
--      makes NFR-05 provable.
--
-- Putting the two ids in the token discloses nothing: the access token issued to the same client
-- already carries school_id and sub as claims. Nor does it let a caller choose a scope to attack --
-- a forged pair opens a transaction scoped to that tenant and user, where the presented secret still
-- has to hash to a stored token_hash owned by them. Wrong ids simply find nothing.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------
-- Tenant context for the DDL below
-- ---------------------------------------------------------------------------
--
-- NO FORCE ROW LEVEL SECURITY is insufficient on PG16: even without FORCE, RLS remains enabled
-- and the tenant_isolation policy's USING clause is still evaluated during the verification scans
-- that adding a NOT NULL column and a foreign key perform. That raises 42704 "unrecognized
-- configuration parameter app.school_id" because no migration session has ever set that GUC.
--
-- DISABLE ROW LEVEL SECURITY clears both the enabled and forced flags atomically, suppressing all
-- policy evaluation for the duration of this transaction. This is safe because ALTER TABLE takes
-- ACCESS EXCLUSIVE, so no other session can read the table through the window in which it is
-- disabled; and the migration is transactional, so a failure anywhere rolls the flag back with
-- everything else.
--
-- Setting the GUC instead is not sufficient. It would make current_setting resolve, but to a value
-- matching no school -- so any scan it enables reads an RLS-filtered *subset*, which is precisely
-- wrong when the scan's purpose is to validate a constraint over every row, and it would make the
-- emptiness assertion below vacuous.
--
-- Every earlier migration avoided the problem by never scanning a FORCE-RLS table: 000026 adds a
-- nullable column and 000020 adds a UNIQUE constraint, an index build that reads the heap directly.
--
-- RLS is re-enabled and FORCE is restored at the end of this file and asserted.
ALTER TABLE app.refresh_tokens DISABLE ROW LEVEL SECURITY;

-- Now that policies are out of the way, this count is the real one. The NOT NULL column below is
-- added with no backfill, which is only sound because app.refresh_tokens has never had a writer --
-- it was created by 000007 in anticipation of ST-071 and nothing ever inserted into it. This turns
-- that from an assumption into a checked precondition: if the table holds data anywhere, the
-- migration aborts instead of failing halfway through with a less legible constraint violation.
DO $assert_empty$
DECLARE
  existing bigint;
BEGIN
  SELECT count(*) INTO existing FROM app.refresh_tokens;
  IF existing > 0 THEN
    RAISE EXCEPTION
      'app.refresh_tokens holds % row(s); 000029 adds a NOT NULL column with no backfill and '
      'assumes the relation has never had a writer', existing
      USING ERRCODE = '23502';
  END IF;
END
$assert_empty$;

-- The client surface a session was established from. Mirrors AUTH_CHANNELS in
-- apps/api/src/modules/auth/channels.ts label-for-label, the same way app.notification_type mirrors
-- its TypeScript constant (000017); the paired conformance test asserts both lists against pg_enum
-- so they cannot drift apart silently.
--
-- Note that channels.ts previously stated no channel column existed anywhere in db/migrations. That
-- was accurate for the access token, where the channel is a claim describing how the token was
-- minted. It stops being accurate here, and deliberately so: a refresh token *is* the session
-- record, and the surface a session was established from is a durable property of that session
-- rather than of any one token minted within it. Storing it is what lets the rotation endpoint
-- decide cookie-versus-body delivery without re-sniffing request headers -- the channel is fixed at
-- login and cannot be changed by a later request. The comment in channels.ts is updated to match.
CREATE TYPE app.auth_channel AS ENUM ('web', 'mobile', 'api');

REVOKE ALL ON TYPE app.auth_channel FROM PUBLIC;
GRANT USAGE ON TYPE app.auth_channel TO studafy_app;

-- ---------------------------------------------------------------------------
-- app.refresh_tokens: the columns the runtime needs
-- ---------------------------------------------------------------------------

-- The tracked device this session belongs to, when there is one. NULLABLE on purpose:
-- app.user_devices (000017) is an FCM push-token registry, not a session-fingerprint table, and a
-- session that never registered for push -- a browser login, most obviously -- has no row there to
-- point at. Forcing the link would mean minting a synthetic push-registry row per browser session,
-- which would corrupt the meaning of that table for the notification code that owns it. Device
-- context for such sessions is still recorded, in the device_name / user_agent / ip_address scalar
-- columns 000007 already provides.
--
-- Composite (device_id, school_id) rather than a single-column FK, matching every other cross-table
-- reference in this schema: it makes a session pointing at another tenant's device unrepresentable
-- at the storage layer rather than merely unreachable through RLS.
ALTER TABLE app.refresh_tokens ADD COLUMN device_id uuid;
ALTER TABLE app.refresh_tokens
  ADD CONSTRAINT fk_refresh_tokens_device
  FOREIGN KEY (device_id, school_id) REFERENCES app.user_devices (id, school_id)
  ON UPDATE RESTRICT ON DELETE RESTRICT;

-- The surface this session was established from, fixed at issuance and copied unchanged onto every
-- child token as the family rotates. It decides whether a rotated token is delivered as a Set-Cookie
-- or in the response body; keeping it on the row rather than reading a request header means a client
-- cannot flip a web session into body delivery and read a token out of a response that was supposed
-- to stay HttpOnly.
ALTER TABLE app.refresh_tokens ADD COLUMN channel app.auth_channel NOT NULL;

-- Two more deliberate indexes, continuing the set 000007 documents:
--   idx_refresh_tokens_school_device  enumerate and terminate one device's sessions; backs the new
--                                     composite FK, whose leading column is otherwise unindexed.
--   idx_refresh_tokens_school_user_active  list a user's live sessions, and the sweep that will
--                                     purge expired ones. Partial because every caller of it wants
--                                     live rows only, and the dead ones dominate the table over
--                                     time -- a rotation chain leaves one live row and N rotated
--                                     ones behind it. The predicate uses only lifecycle columns,
--                                     never expires_at: a now()-relative predicate is not immutable
--                                     and cannot appear in an index (the same constraint 000007
--                                     records on uq_invitations_active). Expiry is evaluated in the
--                                     authenticating transaction instead.
--
-- The rotation point-lookup needs no new index: it matches on token_hash, which
-- uq_refresh_tokens_token_hash (000007) already covers with a unique B-tree.
CREATE INDEX idx_refresh_tokens_school_device
  ON app.refresh_tokens (school_id, device_id);
CREATE INDEX idx_refresh_tokens_school_user_active
  ON app.refresh_tokens (school_id, user_id, expires_at)
  WHERE revoked_at IS NULL AND rotated_at IS NULL;

-- ---------------------------------------------------------------------------
-- Per-user fence
-- ---------------------------------------------------------------------------
--
-- app.refresh_tokens arrived with tenant isolation only, which for this table is a weaker fence than
-- the notification tables next door already carry: it means any authenticated session in a school
-- could read, and revoke, every other user's sessions in that school. For a credential store that is
-- the wrong default, so it takes the same RESTRICTIVE owner policy 000017 applies to user_devices.
-- Restrictive policies AND with the permissive tenant_isolation one, so a row is reachable only when
-- both the school and the user match.
--
-- Scoped TO studafy_app rather than PUBLIC for the reason 000017 spells out: a restrictive policy
-- applies only to the roles it names, so naming the runtime role keeps the fence on every
-- application query while leaving a studafy_admin-owned maintenance path available. Nothing uses
-- that path today.
--
-- CONSEQUENCE FOR CALLERS, and it is not optional: app.current_user_id() (000014) reads
-- current_setting('app.user_id') with no missing_ok, so it raises 42704 when the GUC is unset rather
-- than matching nothing. Every withTenantTx call that touches this table must therefore pass userId,
-- not just schoolId. This is also why the wire token carries the user id as well as the school id --
-- see the header. The failure mode is closed and loud, which is the intent, but it means a caller
-- that forgets gets an error, not an empty result set.
CREATE POLICY refresh_tokens_owner ON app.refresh_tokens
  AS RESTRICTIVE FOR ALL TO studafy_app
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

-- Re-enable RLS (DISABLEd at the top) and restore FORCE. This is the single most important pair
-- of lines in the file: leaving RLS disabled or FORCE off would exempt studafy_admin from
-- tenant_isolation permanently, which is the exact hole 000006 exists to close, and nothing in the
-- application would misbehave to reveal it. The assertion after them is not ceremony -- it is what
-- turns "we remembered" into something the migration proves before it commits.
ALTER TABLE app.refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.refresh_tokens FORCE ROW LEVEL SECURITY;

DO $assert_forced$
DECLARE
  rls_enabled boolean;
  rls_forced boolean;
BEGIN
  SELECT relrowsecurity, relforcerowsecurity INTO rls_enabled, rls_forced
  FROM pg_catalog.pg_class WHERE oid = 'app.refresh_tokens'::regclass;

  IF NOT rls_enabled THEN
    RAISE EXCEPTION 'app.refresh_tokens must leave this migration with ROW LEVEL SECURITY enabled'
      USING ERRCODE = '42501';
  END IF;

  IF NOT rls_forced THEN
    RAISE EXCEPTION 'app.refresh_tokens must leave this migration with FORCE ROW LEVEL SECURITY set'
      USING ERRCODE = '42501';
  END IF;
END
$assert_forced$;

RESET ROLE;
