-- Adds the public invitation-verification read seam without weakening the tenant boundary used by
-- ordinary application queries. app.invitations remains FORCE ROW LEVEL SECURITY: the additional
-- policy applies only while the SECURITY DEFINER function runs as studafy_admin and only to the
-- single SHA-256 digest placed in a transaction-local GUC by that function.

SET ROLE studafy_admin;

CREATE POLICY invitation_token_verification
  ON app.invitations
  AS PERMISSIVE
  FOR SELECT
  TO studafy_admin
  USING (
    token_hash = pg_catalog.decode(
      NULLIF(pg_catalog.current_setting('app.invitation_token_hash', true), ''),
      'hex'
    )
  );

CREATE FUNCTION app.lookup_invitation_for_verification(p_token_hash bytea)
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
END
$function$;

ALTER FUNCTION app.lookup_invitation_for_verification(bytea) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.lookup_invitation_for_verification(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lookup_invitation_for_verification(bytea) TO studafy_app;

RESET ROLE;
