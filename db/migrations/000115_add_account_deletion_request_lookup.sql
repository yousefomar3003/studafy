-- Public web account-deletion request (ST-302).
--
-- Google Play requires a deletion path that works without the app and without signing in. The
-- person proves they own an account by clicking a one-time link sent to its email address, so the
-- API has to go from an email address to the accounts registered under it before any tenant is
-- known. app.users is FORCE ROW LEVEL SECURITY and normalized_email is unique only per school
-- (uq_users_school_normalized_email): the same address can hold an account in several schools, and
-- every one of them belongs to whoever controls that mailbox.
--
-- 1. A SELECT-only policy for studafy_admin, scoped to the single address placed in a
--    transaction-local GUC, and a SECURITY DEFINER resolver that sets it -- the same seam as the
--    returning-user login resolver (000034). No grant to studafy_app is widened; every read and
--    write after resolution runs under the canonical tenant policy.
--
-- 2. An index on normalized_email alone. The existing unique index leads with school_id, so a
--    cross-tenant lookup by address would otherwise scan every user.
--
-- 3. Two email templates: the verification link, and the confirmation sent once a deletion is
--    accepted (by this flow or from account settings).

SET ROLE studafy_admin;

-- 1 -------------------------------------------------------------------------------------------------

CREATE POLICY user_deletion_request_lookup
  ON app.users
  AS PERMISSIVE
  FOR SELECT
  TO studafy_admin
  USING (
    normalized_email = NULLIF(pg_catalog.current_setting('app.deletion_request_email', true), '')
  );

CREATE FUNCTION app.resolve_accounts_for_deletion_request(p_normalized_email text)
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
END
$function$;

ALTER FUNCTION app.resolve_accounts_for_deletion_request(text) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.resolve_accounts_for_deletion_request(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_accounts_for_deletion_request(text) TO studafy_app;

-- 2 -------------------------------------------------------------------------------------------------

CREATE INDEX idx_users_normalized_email ON app.users (normalized_email);

RESET ROLE;

-- 3 -------------------------------------------------------------------------------------------------

ALTER TYPE app.email_template ADD VALUE IF NOT EXISTS 'account-deletion-verification';
ALTER TYPE app.email_template ADD VALUE IF NOT EXISTS 'account-deletion-confirmation';
