-- Makes app.refresh_tokens usable as the session record for ST-071 (refresh token issuance and
-- rotation). The table itself was created by 000007 with the rotation-family model already in
-- place -- token_hash, family_id, parent_token_id, replaced_by_token_id and the device metadata
-- columns all predate this migration. What was missing is everything the *runtime* needs, which is
-- what this adds: a tenant-resolution path for an unauthenticated caller, a link to the tracked
-- device, the client surface the session was established from, a per-user fence, and the two
-- indexes the rotation and enumeration queries need.
--
-- Depends on 000004 (app.schools), 000007 (app.refresh_tokens), 000014 (app.current_user_id),
-- 000017 (app.user_devices).
--
--
-- WHY THERE IS A SEPARATE LOCATOR DIRECTORY.
--
-- A refresh request arrives carrying nothing but a token. It has no access token, so there is no
-- verified school_id, and src/db/tenant-tx.ts cannot open a transaction without one: every policy
-- created by 000006 compares rows against current_setting('app.school_id') with no missing_ok, so
-- an unset GUC raises rather than matching. The token must therefore resolve to a tenant *before*
-- any tenant-scoped query can run, and that lookup has nowhere to live inside the RLS boundary.
--
-- A SECURITY DEFINER function was the obvious candidate and does not work. app.apply_tenant_isolation
-- creates tenant_isolation as PERMISSIVE FOR ALL TO PUBLIC and applies FORCE ROW LEVEL SECURITY, so
-- the owning role is subject to the policy too; and this schema deliberately has no BYPASSRLS role
-- (000002 refuses to proceed if either role carries the attribute, and packages/db/tests/rls.test.ts
-- asserts it stays false). A definer function owned by studafy_admin would be filtered by the same
-- unset GUC and fail closed. That is the isolation guarantee working as designed, not a defect to
-- engineer around, so the lookup moves outside the tenant tables instead of weakening them.
--
-- Hence this directory, and hence its shape. The wire token is `<locator>.<secret>`:
--
--   * `locator` is a random uuid with no meaning of its own. It is NOT the school id -- putting the
--     tenant in the token would publish it to every client and let a caller choose which RLS scope
--     the lookup opens. A forged locator matches nothing and resolves to no tenant at all.
--   * `secret` never appears here. Only app.refresh_tokens.token_hash holds a digest of it, still
--     behind tenant isolation, so this global relation carries no credential material whatsoever.
--     It holds opaque identifiers and nothing else -- no device, no secret, no roles, not even
--     whether the session is still live. And studafy_app cannot read it in bulk regardless: the
--     SELECT grant is withheld and access goes through a one-locator-at-a-time function.
--
-- This is the same reasoning 000028 applied to app.security_events and points at explicitly in its
-- header: a code path that runs before a tenant exists gets its own relation rather than a nullable
-- school_id on a tenant-isolated one. The session record itself stays fully normalized in
-- app.refresh_tokens; this is a directory, not a second copy of it.

SET ROLE studafy_admin;

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

-- THIS IS A GLOBAL TABLE, DELIBERATELY, and is registered in the approved_globals allowlist in
-- db/policies/rls-coverage.ts. It carries school_id as data rather than as a tenant fence: the whole
-- purpose of the relation is to answer "which tenant?" for a caller who does not yet have one, so
-- isolating it by the very column it exists to return would make it unreadable. See the header.
-- user_id is here as well as school_id, and it earns its place by removing a privilege escalation
-- rather than by saving a query. The restrictive refresh_tokens_owner policy below fences rows by
-- app.current_user_id(), so a read whose purpose is to *discover* which user a token belongs to
-- cannot satisfy it -- and app.current_user_id() raises 42704 on the unset GUC rather than returning
-- nothing. The alternatives were to run that read as studafy_admin, which would mean granting the
-- runtime role membership in the schema-owning role purely to read one row, or to drop the per-user
-- fence. Returning both identifiers here means the very next statement can open a normal
-- withTenantTx with both GUCs set, under studafy_app, with every policy in force. No code path in
-- this subsystem runs elevated.
CREATE TABLE app.refresh_token_locators (
  locator uuid CONSTRAINT pk_refresh_token_locators PRIMARY KEY,
  school_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_refresh_token_locators_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_refresh_token_locators_user
    FOREIGN KEY (user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- No index beyond the primary key, and that is the complete set rather than an omission. The only
-- query this table ever serves is the point lookup by locator in the function below, which
-- pk_refresh_token_locators already covers. Nothing reads it by school_id or user_id: enumerating a
-- tenant's sessions is a tenant-scoped question answered from app.refresh_tokens, where RLS applies.
--
-- The composite FK's leading column is user_id, which is therefore unindexed. That is deliberate:
-- the FK exists to make a locator pointing at another tenant's user unrepresentable, and it is
-- verified on insert (an index on the *referenced* side, uq_users_id_school, serves that). Nothing
-- deletes users, so there is no cascade check that would scan this table.

-- studafy_app gets INSERT but NOT SELECT, so it cannot read this table directly at all. Reads go
-- through the function below, which can only answer for one locator at a time. Without that split, a
-- SELECT grant on an un-RLS'd global table would let any tenant enumerate every other tenant's
-- (school_id, user_id) pairs -- opaque ids and no credentials, but a cross-tenant disclosure with no
-- legitimate caller, and one the schema should prevent rather than rely on nobody writing.
REVOKE ALL PRIVILEGES ON TABLE app.refresh_token_locators FROM PUBLIC;
GRANT INSERT ON TABLE app.refresh_token_locators TO studafy_app;

-- Resolve one locator to its owner. SECURITY DEFINER works here precisely because this table is
-- global: there is no row-level security to FORCE, so the definer's own privileges apply and the
-- lookup is not filtered by a GUC that has not been set yet. The same approach is impossible against
-- app.refresh_tokens, and the difference is exactly why the directory is a separate relation.
--
-- STRICT: a NULL locator resolves to NULL rather than scanning. STABLE, not VOLATILE, so the planner
-- can treat it as a constant within a statement.
CREATE FUNCTION app.resolve_refresh_token_locator(p_locator uuid)
RETURNS TABLE (school_id uuid, user_id uuid)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
  SELECT l.school_id, l.user_id
  FROM app.refresh_token_locators AS l
  WHERE l.locator = p_locator
$function$;

ALTER FUNCTION app.resolve_refresh_token_locator(uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.resolve_refresh_token_locator(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_refresh_token_locator(uuid) TO studafy_app;

-- ---------------------------------------------------------------------------
-- app.refresh_tokens: the columns the runtime needs
-- ---------------------------------------------------------------------------
--
-- All three columns are added NOT NULL without a backfill default, which is safe here for a reason
-- worth stating rather than assuming: app.refresh_tokens has never had a writer. It was created by
-- 000007 in anticipation of this ticket and no code path has ever inserted into it, so the relation
-- is empty in every environment. If that assumption is wrong somewhere, this migration aborts on the
-- NOT NULL constraint instead of silently inventing values -- which is the correct failure for a
-- forward-only migration policy with no down step.

-- Resolves to the directory above. UNIQUE because a locator identifies exactly one token: the whole
-- rotation chain shares a family_id, but each individual token gets its own locator, so presenting a
-- rotated token still lands on the rotated row and is detected as reuse rather than resolving to its
-- replacement.
ALTER TABLE app.refresh_tokens ADD COLUMN locator uuid NOT NULL;
ALTER TABLE app.refresh_tokens
  ADD CONSTRAINT uq_refresh_tokens_locator UNIQUE (locator);
ALTER TABLE app.refresh_tokens
  ADD CONSTRAINT fk_refresh_tokens_locator
  FOREIGN KEY (locator) REFERENCES app.refresh_token_locators (locator)
  ON UPDATE RESTRICT ON DELETE RESTRICT;

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
-- not just schoolId. The failure mode is closed and loud, which is the intent -- but it means a
-- caller that forgets gets an error, not an empty result set.
CREATE POLICY refresh_tokens_owner ON app.refresh_tokens
  AS RESTRICTIVE FOR ALL TO studafy_app
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

RESET ROLE;
