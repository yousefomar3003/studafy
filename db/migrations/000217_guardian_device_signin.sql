-- "Add <child> to this phone": a parent signed in on the mobile app puts a linked child's own
-- account on the family phone with one tap, without typing the child's long member ID and password.
-- The API (POST /api/auth/guardian/children/{studentId}/session) mints an ordinary student session
-- for the child, so everything the child does afterwards is the child's own, under the child's
-- identity; this migration adds the two things that flow needs.
--
--   school_settings.allow_parent_device_signin
--       The school's switch. Default ON: the whole point is to spare families the long codes, and a
--       parent is already the person a school hands a child's setup code to. A school that wants
--       children to sign in only with their own credentials turns it off in Settings.
--
--   app.guardian_issued_sessions
--       Marks a session (a refresh-token family) as opened by a guardian rather than by the child's
--       own password, so the child's and an administrator's session lists can say "opened by a
--       parent" and the session can be ended like any other. Keyed by family_id, not token id:
--       a refresh token rotates on every renewal, the family is what a person means by "a session",
--       and keying by family keeps the rotation path (session-service.ts) untouched.
--       user_id is the session's owner (the student account), matching refresh_tokens.user_id so a
--       person-level data request finds these rows through the usual subject link column.
--
-- app.admin_list_user_sessions (000100) gains the marker so the admin panel can show it; its result
-- type changes, so it is dropped and recreated (same body, same owner and grants, plus the join).

SET ROLE studafy_admin;

ALTER TABLE app.school_settings
  ADD COLUMN allow_parent_device_signin boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN app.school_settings.allow_parent_device_signin IS
  'When true, a linked parent can put the child''s own account on their phone from the parent app '
  '(guardian-issued student session, 000217).';

CREATE TABLE app.guardian_issued_sessions (
  school_id uuid NOT NULL,
  family_id uuid NOT NULL,
  user_id uuid NOT NULL,
  guardian_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT pk_guardian_issued_sessions PRIMARY KEY (school_id, family_id),
  CONSTRAINT fk_guardian_issued_sessions_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_guardian_issued_sessions_user FOREIGN KEY (user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_guardian_issued_sessions_guardian FOREIGN KEY (guardian_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_guardian_issued_sessions_not_self CHECK (user_id <> guardian_user_id)
);

-- A student's guardian-opened sessions; also covers the composite user foreign key.
CREATE INDEX idx_guardian_issued_sessions_user
  ON app.guardian_issued_sessions (user_id, school_id);
CREATE INDEX idx_guardian_issued_sessions_guardian
  ON app.guardian_issued_sessions (guardian_user_id, school_id);

COMMENT ON TABLE app.guardian_issued_sessions IS
  'Refresh-token families a linked parent opened for their child from the parent app (000217). '
  'The session itself lives in refresh_tokens and is revoked there.';

REVOKE ALL PRIVILEGES ON TABLE app.guardian_issued_sessions FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT ON TABLE app.guardian_issued_sessions TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'guardian_issued_sessions');

DROP FUNCTION app.admin_list_user_sessions(uuid);

CREATE FUNCTION app.admin_list_user_sessions(target_user_id uuid)
RETURNS TABLE (
  id uuid,
  device_id uuid,
  device_name text,
  channel text,
  user_agent text,
  ip_address inet,
  issued_at timestamptz,
  expires_at timestamptz,
  opened_by_guardian_user_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT DISTINCT ON (rt.family_id)
    rt.id, rt.device_id, rt.device_name, rt.channel::text, rt.user_agent, rt.ip_address,
    rt.issued_at, rt.expires_at, g.guardian_user_id
  FROM app.refresh_tokens AS rt
  LEFT JOIN app.guardian_issued_sessions AS g
    ON g.school_id = rt.school_id AND g.family_id = rt.family_id
  WHERE rt.user_id = target_user_id
    -- Re-asserted rather than left to RLS alone (000100): the tenant fence belongs in the statement.
    AND rt.school_id = current_setting('app.school_id')::uuid
    AND rt.revoked_at IS NULL
    AND rt.rotated_at IS NULL
    AND rt.expires_at > CURRENT_TIMESTAMP
  ORDER BY rt.family_id, rt.issued_at DESC
$function$;

ALTER FUNCTION app.admin_list_user_sessions(uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.admin_list_user_sessions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admin_list_user_sessions(uuid) TO studafy_app;

RESET ROLE;
