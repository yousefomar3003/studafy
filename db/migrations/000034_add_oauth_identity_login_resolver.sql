-- Returning-user OAuth login resolver seam (ST-079).
--
-- Returning-user login receives a verified Microsoft OIDC id_token whose (provider, subject) pair
-- carries no tenant. app.oauth_identities is FORCE ROW LEVEL SECURITY, so an ordinary studafy_app
-- query cannot read the row until app.school_id is already set to the row's school -- the same
-- chicken-and-egg the invitation seams (000031, 000033) solve for their bearer tokens. The
-- (provider, subject) pair is globally unique (uq_oauth_identities_provider_subject in 000007), so
-- resolving it to (user_id, school_id) is a legitimate global lookup; the caller then opens a normal
-- tenant transaction with the resolved school_id and runs every subsequent read/write under the
-- canonical tenant policy.
--
-- This function is read-only and takes no lock. It adds a permissive SELECT policy scoped to the
-- single (provider, subject) pair placed in transaction-local GUCs, and runs as studafy_admin
-- (SECURITY DEFINER). No new grant weakening is introduced; the tenant boundary for every
-- non-definer query is unchanged.

SET ROLE studafy_admin;

CREATE POLICY oauth_identity_login_lookup
  ON app.oauth_identities
  AS PERMISSIVE
  FOR SELECT
  TO studafy_admin
  USING (
    provider = NULLIF(pg_catalog.current_setting('app.oauth_login_provider', true), '')
    AND subject = NULLIF(pg_catalog.current_setting('app.oauth_login_subject', true), '')
  );

CREATE FUNCTION app.resolve_oauth_identity_for_login(p_provider text, p_subject text)
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
END
$function$;

ALTER FUNCTION app.resolve_oauth_identity_for_login(text, text) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.resolve_oauth_identity_for_login(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_oauth_identity_for_login(text, text) TO studafy_app;

RESET ROLE;
