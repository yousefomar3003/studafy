-- QA-026: list a user's live access-token ids so a role change can denylist them.
--
-- Roles travel in the access token. updateUserRole re-inserted app.user_roles and left the target's
-- live tokens carrying the old roles until they expired (up to JWT_ACCESS_TTL_SECONDS), so a demoted
-- administrator kept administering. The fix denylists those tokens; their refresh tokens stay valid,
-- and the next refresh reads the new roles. An administrator cannot read another user's
-- refresh_tokens rows under refresh_tokens_owner, so, like app.admin_revoke_user_sessions (000030),
-- this is a SECURITY DEFINER function owned by studafy_admin, bound by tenant_isolation through
-- app.school_id. Unlike that function it writes nothing and returns token ids (not credentials) and
-- their expiry only. The caller's authorization (USER_MANAGE on the role route) is the route's job.
--
-- Forward-only and additive: one function.

SET ROLE studafy_admin;

CREATE FUNCTION app.admin_user_live_access_jtis(target_user_id uuid)
RETURNS TABLE (access_jti uuid, access_expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT rt.access_jti, rt.access_expires_at
  FROM app.refresh_tokens AS rt
  WHERE rt.user_id = target_user_id
    AND rt.school_id = pg_catalog.current_setting('app.school_id')::uuid
    AND rt.revoked_at IS NULL
    AND rt.access_jti IS NOT NULL
    AND rt.access_expires_at > pg_catalog.clock_timestamp()
$function$;

ALTER FUNCTION app.admin_user_live_access_jtis(uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.admin_user_live_access_jtis(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admin_user_live_access_jtis(uuid) TO studafy_app;

RESET ROLE;
