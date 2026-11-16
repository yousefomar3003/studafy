-- QA-018: the login and lookup resolvers restore every transaction setting they touch.
--
-- Each of these SECURITY DEFINER functions arms a transaction-local setting that switches on a
-- permissive lookup policy (app.invitation_token_hash, app.oauth_login_provider/subject,
-- app.deletion_request_email) and overwrites app.school_id, and never put them back. Callers run one
-- statement per transaction today, so it was latent, but a caller that ran more queries in the same
-- transaction -- a system transaction in particular -- would keep matching other schools' rows
-- through that policy. Same bodies as before; each now saves the previous values first and restores
-- them after RETURN QUERY (which appends the rows and carries on), as 000200/000216/000221/000226 do.
-- A caller with no school armed gets the nil UUID back, as before: tenant policies then match
-- nothing rather than fail on an empty value.
--
-- Forward-only: CREATE OR REPLACE with unchanged signatures and grants.

SET ROLE studafy_admin;

CREATE OR REPLACE FUNCTION app.lookup_invitation_for_verification(p_token_hash bytea)
RETURNS TABLE (
  found boolean,
  candidate_hash bytea,
  normalized_email text,
  expires_at timestamptz,
  revoked_at timestamptz,
  consumed_at timestamptz,
  school_name text,
  school_status app.school_status
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  previous_school_id text := pg_catalog.current_setting('app.school_id', true);
  previous_invitation_token_hash text := pg_catalog.current_setting('app.invitation_token_hash', true);
BEGIN
  IF p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'invitation verification digest must be exactly 32 bytes'
      USING ERRCODE = '22023';
  END IF;

  -- The canonical tenant policy calls current_setting without missing_ok. Give it a guaranteed
  -- non-matching tenant while the digest policy above grants access to exactly one candidate row.
  -- Both values are transaction-local and cannot survive a PgBouncer transaction-pool checkout.
  PERFORM pg_catalog.set_config(
    'app.school_id',
    '00000000-0000-0000-0000-000000000000',
    true
  );
  PERFORM pg_catalog.set_config(
    'app.invitation_token_hash',
    pg_catalog.encode(p_token_hash, 'hex'),
    true
  );

  -- Always return exactly one fixed-shape row. The dummy values make the application perform the
  -- same hash comparison, email masking, and lifecycle evaluation work for an index miss.
  RETURN QUERY
  SELECT
    candidate.token_hash IS NOT NULL,
    COALESCE(
      candidate.token_hash,
      pg_catalog.decode(
        '7d9e667c7a1a4f7f4e6b8f19be7b4237a734d0d69194c6b1e39b47e97c789f23',
        'hex'
      )
    ),
    COALESCE(candidate.normalized_email, 'dummy@example.invalid'),
    COALESCE(candidate.expires_at, '9999-12-31 23:59:59+00'::timestamptz),
    candidate.revoked_at,
    candidate.consumed_at,
    COALESCE(candidate.school_name, 'Unavailable'),
    COALESCE(candidate.school_status, 'active'::app.school_status)
  FROM (SELECT true) AS singleton
  LEFT JOIN LATERAL (
    SELECT
      invitation.token_hash,
      invitation.normalized_email,
      invitation.expires_at,
      invitation.revoked_at,
      invitation.consumed_at,
      school.name AS school_name,
      school.status AS school_status
    FROM app.invitations AS invitation
    INNER JOIN app.schools AS school ON school.id = invitation.school_id
    WHERE invitation.token_hash = p_token_hash
    LIMIT 1
  ) AS candidate ON true;
  -- QA-018: leave the caller's transaction as it was.
  PERFORM pg_catalog.set_config(
    'app.school_id',
    COALESCE(NULLIF(previous_school_id, ''), '00000000-0000-0000-0000-000000000000'),
    true
  );
  PERFORM pg_catalog.set_config('app.invitation_token_hash', COALESCE(previous_invitation_token_hash, ''), true);
END
$function$;

CREATE OR REPLACE FUNCTION app.resolve_oauth_identity_for_login(p_provider text, p_subject text)
RETURNS TABLE (
  found boolean,
  user_id uuid,
  school_id uuid,
  identity_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  previous_school_id text := pg_catalog.current_setting('app.school_id', true);
  previous_oauth_login_provider text := pg_catalog.current_setting('app.oauth_login_provider', true);
  previous_oauth_login_subject text := pg_catalog.current_setting('app.oauth_login_subject', true);
BEGIN
  IF p_provider IS NULL OR btrim(p_provider) = ''
     OR p_subject IS NULL OR btrim(p_subject) = '' THEN
    RAISE EXCEPTION 'oauth identity lookup requires a non-empty provider and subject'
      USING ERRCODE = '22023';
  END IF;

  -- The canonical tenant policy calls current_setting without missing_ok. Give it a guaranteed
  -- non-matching tenant while the (provider, subject) policy above grants access to exactly one
  -- candidate row. All three values are transaction-local and cannot survive a PgBouncer
  -- transaction-pool checkout.
  PERFORM pg_catalog.set_config(
    'app.school_id',
    '00000000-0000-0000-0000-000000000000',
    true
  );
  PERFORM pg_catalog.set_config('app.oauth_login_provider', p_provider, true);
  PERFORM pg_catalog.set_config('app.oauth_login_subject', p_subject, true);

  -- Always return exactly one fixed-shape row. On an index miss the identifiers are the nil UUID and
  -- found is false, so the caller performs the same constant work whether or not the identity exists.
  RETURN QUERY
  SELECT
    candidate.id IS NOT NULL,
    COALESCE(candidate.user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(candidate.school_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(candidate.id, '00000000-0000-0000-0000-000000000000'::uuid)
  FROM (SELECT true) AS singleton
  LEFT JOIN LATERAL (
    SELECT identity.id, identity.user_id, identity.school_id
    FROM app.oauth_identities AS identity
    WHERE identity.provider = p_provider
      AND identity.subject = p_subject
    LIMIT 1
  ) AS candidate ON true;
  -- QA-018: leave the caller's transaction as it was.
  PERFORM pg_catalog.set_config(
    'app.school_id',
    COALESCE(NULLIF(previous_school_id, ''), '00000000-0000-0000-0000-000000000000'),
    true
  );
  PERFORM pg_catalog.set_config('app.oauth_login_provider', COALESCE(previous_oauth_login_provider, ''), true);
  PERFORM pg_catalog.set_config('app.oauth_login_subject', COALESCE(previous_oauth_login_subject, ''), true);
END
$function$;

CREATE OR REPLACE FUNCTION app.resolve_accounts_for_deletion_request(p_normalized_email text)
RETURNS TABLE (
  user_id uuid,
  school_id uuid,
  school_name text,
  email text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  previous_school_id text := pg_catalog.current_setting('app.school_id', true);
  previous_deletion_request_email text := pg_catalog.current_setting('app.deletion_request_email', true);
BEGIN
  IF p_normalized_email IS NULL
     OR p_normalized_email <> lower(btrim(p_normalized_email))
     OR p_normalized_email = '' THEN
    RAISE EXCEPTION 'deletion request lookup requires a normalized, non-empty email'
      USING ERRCODE = '22023';
  END IF;

  -- The canonical tenant policy calls current_setting without missing_ok, so it gets a guaranteed
  -- non-matching tenant; the policy above grants access to exactly this address. Both values are
  -- transaction-local and cannot survive a PgBouncer transaction-pool checkout.
  PERFORM pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
  PERFORM pg_catalog.set_config('app.deletion_request_email', p_normalized_email, true);

  -- Archived accounts are already deleted (or were retired by the school) and have nothing left to
  -- act on. app.schools is global and has no RLS.
  RETURN QUERY
  SELECT account.id, account.school_id, school.name, account.email
  FROM app.users AS account
  JOIN app.schools AS school ON school.id = account.school_id
  WHERE account.normalized_email = p_normalized_email
    AND account.status <> 'archived'::app.user_status
  ORDER BY school.name, account.id;
  -- QA-018: leave the caller's transaction as it was.
  PERFORM pg_catalog.set_config(
    'app.school_id',
    COALESCE(NULLIF(previous_school_id, ''), '00000000-0000-0000-0000-000000000000'),
    true
  );
  PERFORM pg_catalog.set_config('app.deletion_request_email', COALESCE(previous_deletion_request_email, ''), true);
END
$function$;

CREATE OR REPLACE FUNCTION app.resolve_member_code_for_login(p_code text)
RETURNS TABLE (found boolean, user_id uuid, school_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  previous_school_id text := pg_catalog.current_setting('app.school_id', true);
  normalized text := upper(btrim(coalesce(p_code, '')));
  digits text;
  split integer;
  candidate_school uuid;
  hit record;
  -- Locals rather than the OUT columns: `found` would shadow PL/pgSQL's FOUND, which every
  -- statement below rewrites.
  hit_found boolean := false;
  hit_user uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  hit_school uuid := '00000000-0000-0000-0000-000000000000'::uuid;
BEGIN

  IF normalized ~ '^(STU|TCH|PAR|ATT)-[0-9]{6,12}$' THEN
    digits := substr(normalized, 5);
    FOR split IN 1 .. char_length(digits) - 5 LOOP
      SELECT s.id INTO candidate_school
      FROM app.schools AS s
      WHERE s.school_number = substr(digits, 1, split)::integer;
      CONTINUE WHEN candidate_school IS NULL;

      PERFORM pg_catalog.set_config('app.school_id', candidate_school::text, true);
      SELECT mc.user_id, mc.school_id INTO hit
      FROM app.member_codes AS mc
      WHERE mc.school_id = candidate_school AND mc.code = normalized;
      IF hit.user_id IS NOT NULL THEN
        hit_found := true;
        hit_user := hit.user_id;
        hit_school := hit.school_id;
        EXIT;
      END IF;
    END LOOP;
  END IF;

  -- Leave no tenant armed; the caller arms the resolved school itself.
  PERFORM pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
  RETURN QUERY SELECT hit_found, hit_user, hit_school;
  -- QA-018: leave the caller's transaction as it was.
  PERFORM pg_catalog.set_config(
    'app.school_id',
    COALESCE(NULLIF(previous_school_id, ''), '00000000-0000-0000-0000-000000000000'),
    true
  );
END
$function$;

RESET ROLE;
