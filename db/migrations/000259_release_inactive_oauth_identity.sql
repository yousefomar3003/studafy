-- A Google or Microsoft account suspended at one school can accept another school's invitation.
--
-- A (provider, subject) pair is globally unique (uq_oauth_identities_provider_subject in 000007): one
-- sign-in account belongs to one Studafy user in one school, and returning-user login resolves the
-- school from it (000034). So a person suspended (or archived) at school A could never accept school
-- B's invitation with the same email: linking the identity in B collided with A's row and activation
-- failed with OAUTH_IDENTITY_EXISTS, although A no longer lets that account in.
--
-- app.release_inactive_oauth_identity unlinks the pair from its old account when, and only when:
--   * the caller has a school armed (the accepting school, app.school_id), and
--   * the identity belongs to a DIFFERENT school, and
--   * that school's user is suspended or archived.
-- An identity on an active (or invited) account, or one in the accepting school itself, is left
-- untouched, so activation still fails with OAUTH_IDENTITY_EXISTS exactly as before. The old user row,
-- its roles and its history stay as they are; it simply no longer has this sign-in linked, and if
-- school A later reinstates it, A re-invites it with a sign-in that is free.
--
-- Activation calls it inside its tenant transaction, before linking, so the unlink rolls back with
-- everything else if activation fails. Like the 000245 resolvers, it saves and restores every
-- transaction setting it touches.

SET ROLE studafy_admin;

CREATE FUNCTION app.release_inactive_oauth_identity(p_provider text, p_subject text)
RETURNS TABLE (
  released boolean,
  previous_school_id uuid,
  previous_user_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  caller_school_id text := pg_catalog.current_setting('app.school_id', true);
  previous_oauth_login_provider text := pg_catalog.current_setting('app.oauth_login_provider', true);
  previous_oauth_login_subject text := pg_catalog.current_setting('app.oauth_login_subject', true);
  candidate_id uuid;
  candidate_school_id uuid;
  candidate_user_id uuid;
  candidate_status app.user_status;
BEGIN
  IF p_provider IS NULL OR btrim(p_provider) = ''
     OR p_subject IS NULL OR btrim(p_subject) = '' THEN
    RAISE EXCEPTION 'oauth identity release requires a non-empty provider and subject'
      USING ERRCODE = '22023';
  END IF;

  IF caller_school_id IS NULL OR caller_school_id = ''
     OR caller_school_id = '00000000-0000-0000-0000-000000000000' THEN
    RAISE EXCEPTION 'oauth identity release requires the accepting school to be armed'
      USING ERRCODE = '22023';
  END IF;

  -- Find the pair through the 000034 lookup policy, with a guaranteed non-matching tenant.
  PERFORM pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
  PERFORM pg_catalog.set_config('app.oauth_login_provider', p_provider, true);
  PERFORM pg_catalog.set_config('app.oauth_login_subject', p_subject, true);

  SELECT identity.id, identity.school_id, identity.user_id
    INTO candidate_id, candidate_school_id, candidate_user_id
  FROM app.oauth_identities AS identity
  WHERE identity.provider = p_provider
    AND identity.subject = p_subject
  LIMIT 1;

  IF candidate_id IS NOT NULL AND candidate_school_id <> caller_school_id::uuid THEN
    -- Read and unlink under the old school's own tenant policy, locking the user row so a concurrent
    -- reinstatement either lands first (and keeps the identity) or waits for this unlink.
    PERFORM pg_catalog.set_config('app.school_id', candidate_school_id::text, true);

    SELECT account.status
      INTO candidate_status
    FROM app.users AS account
    WHERE account.id = candidate_user_id
      AND account.school_id = candidate_school_id
    FOR UPDATE;

    IF candidate_status IN ('suspended', 'archived') THEN
      DELETE FROM app.oauth_identities AS identity
      WHERE identity.id = candidate_id
        AND identity.school_id = candidate_school_id;
    ELSE
      candidate_id := NULL;
    END IF;
  ELSE
    candidate_id := NULL;
  END IF;

  PERFORM pg_catalog.set_config('app.school_id', caller_school_id, true);
  PERFORM pg_catalog.set_config('app.oauth_login_provider', COALESCE(previous_oauth_login_provider, ''), true);
  PERFORM pg_catalog.set_config('app.oauth_login_subject', COALESCE(previous_oauth_login_subject, ''), true);

  RETURN QUERY
  SELECT
    candidate_id IS NOT NULL,
    CASE WHEN candidate_id IS NOT NULL THEN candidate_school_id END,
    CASE WHEN candidate_id IS NOT NULL THEN candidate_user_id END;
END
$function$;

ALTER FUNCTION app.release_inactive_oauth_identity(text, text) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.release_inactive_oauth_identity(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.release_inactive_oauth_identity(text, text) TO studafy_app;

RESET ROLE;
