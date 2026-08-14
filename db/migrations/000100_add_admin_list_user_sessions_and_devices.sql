-- ST-187: read-visibility into a target user's sessions and devices for administrators.
--
-- 000030 gave administrators app.admin_revoke_user_sessions -- they could already terminate another
-- user's sessions blind, but never see what they were about to terminate. The deactivation dialog and
-- the per-user device-sessions panel this ticket adds both need to show that list before an
-- administrator acts on it, and nothing in the schema could answer that: GET /api/auth/sessions and
-- GET /api/auth/devices only ever answer for the caller, because refresh_tokens_owner (000029) is a
-- RESTRICTIVE policy scoped TO studafy_app comparing user_id to app.current_user_id() -- the exact
-- policy 000030's header explains an administrator's target is "by construction" hidden behind.
--
-- Same shape as app.admin_revoke_user_sessions, and for the same reason: a SECURITY DEFINER function
-- owned by studafy_admin is not named by refresh_tokens_owner, so it does not apply inside one, while
-- the permissive tenant_isolation policy (000006, FORCE RLS) still does -- confining every read to
-- current_setting('app.school_id') and making a cross-tenant read unrepresentable rather than merely
-- unauthorized, exactly like the write path. Read-only and LANGUAGE sql, following the simpler shape
-- 000076's app.find_student_id_by_admission_number set for a lookup with no multi-statement body,
-- rather than 000030's plpgsql (which needed it only for the paired UPDATE ... UPDATE of a
-- revocation).
--
-- No new grant is needed on app.refresh_tokens or app.user_devices themselves: SECURITY DEFINER runs
-- as the owning role (studafy_admin), which already has table access; only EXECUTE on the function is
-- granted to studafy_app below.

SET LOCAL ROLE studafy_admin;

-- Mirrors listActiveSessions (session-service.ts): one row per family, not per token, so a
-- long-lived session that rotated hundreds of times still shows as a single entry. token_hash stays
-- out of the projection for the same reason it does there -- this response reaches a client.
CREATE FUNCTION app.admin_list_user_sessions(target_user_id uuid)
RETURNS TABLE (
  id uuid,
  device_id uuid,
  device_name text,
  channel text,
  user_agent text,
  ip_address inet,
  issued_at timestamptz,
  expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT DISTINCT ON (family_id)
    id, device_id, device_name, channel::text, user_agent, ip_address, issued_at, expires_at
  FROM app.refresh_tokens
  WHERE user_id = target_user_id
    -- Re-asserted rather than left to RLS alone, matching admin_revoke_user_sessions: the tenant
    -- fence belongs in the statement, not only in a policy a future refactor could loosen unnoticed.
    AND school_id = current_setting('app.school_id')::uuid
    AND revoked_at IS NULL
    AND rotated_at IS NULL
    AND expires_at > CURRENT_TIMESTAMP
  ORDER BY family_id, issued_at DESC
$function$;

ALTER FUNCTION app.admin_list_user_sessions(uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.admin_list_user_sessions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admin_list_user_sessions(uuid) TO studafy_app;

-- Mirrors listUserDevices: a device is the thing a person and an administrator alike recognise --
-- "the phone this account is signed in on" -- distinct from a session, which is one login on it.
-- fcm_token stays out of the projection for the same reason it does in the self-service query: it is
-- a credential for the push channel.
CREATE FUNCTION app.admin_list_user_devices(target_user_id uuid)
RETURNS TABLE (
  id uuid,
  platform text,
  last_seen timestamptz,
  created_at timestamptz,
  active_session_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT d.id, d.platform::text, d.last_seen, d.created_at,
         count(rt.family_id) AS active_session_count
  FROM app.user_devices AS d
  LEFT JOIN app.refresh_tokens AS rt
         ON rt.device_id = d.id
        AND rt.school_id = current_setting('app.school_id')::uuid
        AND rt.revoked_at IS NULL
        AND rt.rotated_at IS NULL
        AND rt.expires_at > CURRENT_TIMESTAMP
  WHERE d.user_id = target_user_id
    AND d.school_id = current_setting('app.school_id')::uuid
    AND d.revoked_at IS NULL
  GROUP BY d.id, d.platform, d.last_seen, d.created_at
  ORDER BY d.last_seen DESC
$function$;

ALTER FUNCTION app.admin_list_user_devices(uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.admin_list_user_devices(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admin_list_user_devices(uuid) TO studafy_app;

RESET ROLE;
