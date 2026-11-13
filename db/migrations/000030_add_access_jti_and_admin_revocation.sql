-- Connects the two halves of session revocation for ST-072 (logout and device revocation).
--
-- ST-070 built a Redis jti denylist and ST-071 built refresh-token families, and nothing joined
-- them: revoking a family stops the *refresh*, but the access token already in the client's hands
-- stays cryptographically valid until its own exp. With JWT_ACCESS_TTL_SECONDS at 900 that is a
-- fifteen-minute window in which a logged-out -- or admin-terminated -- credential still opens every
-- protected endpoint. Closing it means denylisting the outstanding jti at the moment the family is
-- revoked, and that requires knowing which jti a session most recently minted, which nothing
-- recorded. modules/auth/jwt/sign.ts generated it with randomUUID() inside the signing call and
-- discarded it.
--
-- Depends on 000007 (app.refresh_tokens), 000014 (app.current_user_id), 000017 (app.user_devices),
-- 000029 (device_id, channel, refresh_tokens_owner).
--
--
-- WHY THE ADMIN PATH NEEDS A SECURITY DEFINER FUNCTION.
--
-- 000029 added refresh_tokens_owner, a RESTRICTIVE policy comparing user_id to app.current_user_id().
-- Restrictive policies AND with the permissive tenant one, so studafy_app can only ever see its own
-- rows. That is right for the self-service routes and fatal for the admin ones: an administrator
-- terminating another user's sessions is, by construction, reaching for rows the policy hides.
--
-- Opening the tenant transaction as the *target* user would evade the policy, and is rejected here.
-- middleware/auditEmitter.ts reads actor_id from the app.user_id GUC, so that approach would file
-- every forced logout as though the victim had performed it, destroying the audit trail precisely
-- where it matters most.
--
-- The escape hatch is the one 000029 left open on purpose. Its policy is scoped TO studafy_app, and
-- it records why: "naming the runtime role keeps the fence on every application query while leaving
-- a studafy_admin-owned maintenance path available. Nothing uses that path today." This is that
-- path's first user. A function owned by studafy_admin is not subject to a policy naming only
-- studafy_app, so refresh_tokens_owner does not apply inside it.
--
-- Note that this is NOT the design 000029's header rules out. That entry rejects a SECURITY DEFINER
-- function for the *unauthenticated refresh* path, and the reason is specific: tenant_isolation is
-- PERMISSIVE FOR ALL TO PUBLIC under FORCE ROW LEVEL SECURITY, so it binds studafy_admin too, and a
-- refresh request has no established tenant -- the GUC would be unset and the function would fail
-- closed. Here the caller is a fully authenticated administrator, app.school_id is set to their
-- school, and tenant_isolation binding the function owner is the property being relied on rather
-- than an obstacle: it is what makes a cross-tenant revocation unrepresentable rather than merely
-- unauthorized. The function drops the per-user fence and keeps the per-tenant one, which is exactly
-- the reach an administrator should have.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------
-- Tenant context for the DDL below
-- ---------------------------------------------------------------------------
--
-- Same reasoning as 000029, and the same remedy. Adding the two nullable columns below would not
-- scan on its own -- 000026 adds a nullable column to a partitioned table without this dance -- but
-- the CHECK constraint that pairs them does, and a validating scan on a FORCE-RLS table evaluates
-- tenant_isolation, which raises 42704 for an unset app.school_id rather than matching nothing.
--
-- Unlike 000029 there is no emptiness assertion here, because there must not be one: ST-071 shipped,
-- so app.refresh_tokens now has a writer and may legitimately hold rows. Nothing needs backfilling.
-- Both columns are nullable and every existing row leaves them NULL, which satisfies the paired
-- CHECK by construction, so the validating scan passes over live data without a rewrite.
--
-- RLS is re-enabled and FORCE restored at the end of this file, and asserted.
ALTER TABLE app.refresh_tokens DISABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- app.refresh_tokens: the access token this session last minted
-- ---------------------------------------------------------------------------
--
-- One row in this table is one refresh token, and each one is minted alongside exactly one access
-- token. Recording that access token's jti and exp on the row turns "revoke this family" into "and
-- here are the jtis to denylist" -- a projection of an UPDATE ... RETURNING rather than a second
-- lookup against some separate registry.
--
-- Storing the jti is not storing a credential. A jti is an opaque identifier that appears in
-- plaintext inside every token that carries it; it is not secret, it is not sufficient to construct
-- a token, and unlike token_hash next door it needs no digesting. What it buys is the ability to
-- name a specific outstanding access token after the fact, which is the whole of what revocation
-- needs.
--
-- access_expires_at is stored rather than derived from issued_at + a TTL constant. The TTL is
-- configuration (env.JWT_ACCESS_TTL_SECONDS) and can be changed between deployments, so deriving it
-- would compute the wrong expiry for every token minted under a previous value -- and the denylist
-- TTL computed from it is exactly what bounds Redis memory. A wrong value here either drops the
-- denylist entry while the token is still live (an authentication bypass) or pins it long after the
-- token is worthless (unbounded growth). It is cheap to store and expensive to guess.
--
-- Both NULLABLE, for two distinct reasons that both matter. Rows written before this migration have
-- no jti to record and are not backfillable -- the value was never persisted anywhere. And
-- issueTokenPair composes into caller-owned transactions, so a future login path could insert a
-- session row in a unit of work where signing has not happened yet.
ALTER TABLE app.refresh_tokens ADD COLUMN access_jti uuid;
ALTER TABLE app.refresh_tokens ADD COLUMN access_expires_at timestamptz;

-- The two are meaningful only together: a jti with no expiry cannot be given a denylist TTL, and an
-- expiry with no jti names nothing. Written as an equality between two IS NULL tests rather than a
-- pair of ORed clauses because that is the whole invariant in one readable line, and it makes the
-- half-populated state unrepresentable in either direction.
ALTER TABLE app.refresh_tokens
  ADD CONSTRAINT ck_refresh_tokens_access_token
  CHECK ((access_jti IS NULL) = (access_expires_at IS NULL));

-- ---------------------------------------------------------------------------
-- Indexes for batch revocation
-- ---------------------------------------------------------------------------
--
-- ONE index, not two, and the omission is the more interesting half.
--
-- Family-scoped revocation -- every logout, every single-session termination -- is already served by
-- idx_refresh_tokens_school_family on (school_id, family_id), which 000007 created for precisely
-- this ("revoke an entire rotation family in one tenant", line 214). A partial, INCLUDE-carrying
-- variant of it was drafted here and dropped: revocation is an UPDATE, so the heap has to be visited
-- to write revoked_at regardless, which means an INCLUDE can never turn the RETURNING projection
-- into an index-only scan. It would have cost writes on every insert to buy a marginally smaller
-- index for one query shape 000007 already covers.
--
-- The user/device index below has no such predecessor. Partial on revoked_at IS NULL because dead
-- rows dominate this table over time -- a 30-day session that rotated hourly leaves ~720 of them
-- behind one live tip -- so the index stays proportional to live sessions rather than to total
-- rotations. The predicate does not mention expires_at, for the reason 000029 records: a
-- now()-relative expression is not immutable and cannot appear in an index. Expiry is evaluated in
-- the revoking transaction.
--
-- It does not duplicate idx_refresh_tokens_school_user_active from 000029, and the difference is
-- load-bearing rather than incidental. That index is additionally partial on rotated_at IS NULL,
-- so it excludes rotated-but-not-revoked rows -- and those are exactly the rows this query must
-- reach. A rotated refresh token is spent, but the *access* token it minted on the way past can
-- easily still be live, and skipping those rows would leave behind precisely the credentials
-- revocation exists to kill.
--
-- The (school_id, user_id) prefix serves the per-user global logout with the device column simply
-- unused, so one index covers both the device-scoped and user-scoped teardowns.
CREATE INDEX idx_refresh_tokens_school_user_device_active
  ON app.refresh_tokens (school_id, user_id, device_id)
  INCLUDE (access_jti, access_expires_at)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Administrative revocation
-- ---------------------------------------------------------------------------
--
-- Revokes another user's sessions, optionally narrowed to one device, and returns the access-token
-- identifiers it just orphaned so the caller can denylist them. See this file's header for why it
-- must be SECURITY DEFINER and why that does not contradict 000029.
--
-- Its reach is bounded the same three ways app.claim_device_token's is:
--
--   1. It only ever sets revoked_at. It cannot read a token_hash, move a row between users, or
--      delete anything. The columns it returns -- a jti and an expiry -- are not credentials.
--   2. Every statement is confined to current_setting('app.school_id')::uuid, so it cannot cross a
--      tenant boundary no matter what target_user_id names. A caller passing a real user id from
--      another school gets the same empty result as one passing a uuid that exists nowhere, which is
--      what keeps the admin routes from becoming a cross-tenant existence oracle.
--   3. It takes the target as an explicit argument rather than deriving one, so it can revoke only
--      what the caller named.
--
-- No missing_ok on current_setting: an unset GUC raises 42704 rather than resolving to NULL and
-- silently matching no rows. A revocation that quietly does nothing is the worst possible failure
-- mode for this function, so it fails loudly instead.
CREATE FUNCTION app.admin_revoke_user_sessions(
  target_user_id uuid,
  target_device_id uuid DEFAULT NULL
)
RETURNS TABLE (
  revoked_token_id uuid,
  revoked_family_id uuid,
  revoked_access_jti uuid,
  revoked_access_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  caller_school_id uuid := current_setting('app.school_id')::uuid;
BEGIN
  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'target user id must be supplied'
      USING ERRCODE = '22023';
  END IF;

  -- Whole families, not the matched rows alone. A caller naming a device holds the live tip of each
  -- of that device's chains; revoking only the rows carrying that device_id would leave the rest of
  -- each family intact and the session refreshable. The family is the unit of revocation everywhere
  -- in this subsystem -- see revokeSession in services/session-service.ts -- and it has to stay the
  -- unit here, or the admin path would be the one place a "revoked" session survives.
  RETURN QUERY
  WITH targeted AS (
    SELECT DISTINCT rt.family_id
    FROM app.refresh_tokens AS rt
    WHERE rt.user_id = target_user_id
      AND rt.school_id = caller_school_id
      AND rt.revoked_at IS NULL
      AND (target_device_id IS NULL OR rt.device_id = target_device_id)
  )
  UPDATE app.refresh_tokens AS victim
  SET revoked_at = CURRENT_TIMESTAMP
  FROM targeted
  WHERE victim.family_id = targeted.family_id
    -- Re-asserted rather than inherited through the CTE. These are the predicates that make the
    -- statement tenant-safe, and an UPDATE ... FROM whose fence lives only in a subquery is one
    -- refactor away from losing it.
    AND victim.school_id = caller_school_id
    AND victim.user_id = target_user_id
    AND victim.revoked_at IS NULL
  RETURNING victim.id, victim.family_id, victim.access_jti, victim.access_expires_at;

  -- The device registry, revoked alongside, for the reason revokeReusedSession gives: app.user_devices
  -- is what "the device" means in this schema, and leaving its push token live would keep delivering
  -- notifications to a handset whose sessions were just terminated. Soft revocation only, never a
  -- delete -- the row is evidence.
  UPDATE app.user_devices
  SET revoked_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE user_id = target_user_id
    AND school_id = caller_school_id
    AND revoked_at IS NULL
    AND (target_device_id IS NULL OR id = target_device_id);

  RETURN;
END
$function$;

ALTER FUNCTION app.admin_revoke_user_sessions(uuid, uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.admin_revoke_user_sessions(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admin_revoke_user_sessions(uuid, uuid) TO studafy_app;

-- Re-enable RLS (DISABLEd at the top) and restore FORCE, then prove it. 000029 calls this the single
-- most important pair of lines in that file and the same is true here: leaving either off would
-- exempt studafy_admin from tenant_isolation permanently -- the exact hole 000006 exists to close --
-- and nothing in the application would misbehave to reveal it. It would also silently widen the
-- function above from tenant-scoped to global, since tenant_isolation binding the owner is the only
-- thing fencing it.
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
