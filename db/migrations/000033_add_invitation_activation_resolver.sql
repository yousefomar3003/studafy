-- Account activation resolver seam (ST-078).
--
-- Activation receives a bearer invitation token that carries no tenant. app.invitations is
-- FORCE ROW LEVEL SECURITY, so an ordinary studafy_app query cannot read the row until app.school_id
-- is already set to the row's school — a chicken-and-egg the public verification seam (000031)
-- solves for reads. Activation needs the same bridge but must go on to lock and mutate, so it first
-- resolves token_hash -> (invitation_id, school_id) here, then opens a normal tenant transaction with
-- the real school_id and takes the FOR UPDATE lock under the canonical tenant policy.
--
-- This function is read-only and takes no lock. It reuses the permissive `invitation_token_verification`
-- SELECT policy created in 000031: both run as studafy_admin (SECURITY DEFINER) and scope access to the
-- single digest placed in the transaction-local `app.invitation_token_hash` GUC. No new policy or grant
-- weakening is introduced; the tenant boundary for every non-definer query is unchanged.

SET ROLE studafy_admin;

CREATE FUNCTION app.resolve_invitation_for_activation(p_token_hash bytea)
RETURNS TABLE (
  found boolean,
  invitation_id uuid,
  school_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'invitation activation digest must be exactly 32 bytes'
      USING ERRCODE = '22023';
  END IF;

  -- The canonical tenant policy calls current_setting without missing_ok. Give it a guaranteed
  -- non-matching tenant while the digest policy from 000031 grants access to exactly one candidate
  -- row. Both values are transaction-local and cannot survive a PgBouncer transaction-pool checkout.
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

  -- Always return exactly one fixed-shape row. On an index miss the identifiers are the nil UUID and
  -- found is false, so the caller performs the same constant work whether or not the token exists.
  RETURN QUERY
  SELECT
    candidate.id IS NOT NULL,
    COALESCE(candidate.id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(candidate.school_id, '00000000-0000-0000-0000-000000000000'::uuid)
  FROM (SELECT true) AS singleton
  LEFT JOIN LATERAL (
    SELECT invitation.id, invitation.school_id
    FROM app.invitations AS invitation
    WHERE invitation.token_hash = p_token_hash
    LIMIT 1
  ) AS candidate ON true;
END
$function$;

ALTER FUNCTION app.resolve_invitation_for_activation(bytea) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.resolve_invitation_for_activation(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_invitation_for_activation(bytea) TO studafy_app;

RESET ROLE;
