-- QA-014: resolve a Resend message id to the schools holding deliveries for it, without RLS bypass.
--
-- The email webhook (apps/api/src/email/webhook.ts transitionDeliveries) has to find every school
-- whose app.email_deliveries row carries a bounced or complained message id. That lookup is cross-
-- tenant by nature, and the webhook did it with a plain SELECT on a FORCE-RLS table, which only
-- returned rows because the production login bypasses RLS. Under a least-privilege login it returns
-- nothing and the delivery never leaves 'sent'.
--
-- Same seam as the deletion-request (000115), OAuth login (000034) and invitation (000031) lookups:
-- a SECURITY DEFINER resolver owned by studafy_admin, plus a SELECT-only, studafy_admin-only policy
-- keyed on one transaction-local setting, so it cannot widen any write and matches nothing when the
-- setting is unset. Unlike those, the resolver restores both settings before returning (QA-018), so
-- nothing stays armed for the rest of the caller's transaction. It returns school ids only.
--
-- Forward-only and additive: one policy, one function.

SET ROLE studafy_admin;

CREATE POLICY email_delivery_message_lookup
  ON app.email_deliveries
  AS PERMISSIVE
  FOR SELECT
  TO studafy_admin
  USING (
    message_id = NULLIF(pg_catalog.current_setting('app.email_delivery_message', true), '')
  );

CREATE FUNCTION app.resolve_email_delivery_schools(p_message_id text)
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  previous_school text := pg_catalog.current_setting('app.school_id', true);
  previous_message text := pg_catalog.current_setting('app.email_delivery_message', true);
BEGIN
  IF p_message_id IS NULL OR p_message_id = '' OR p_message_id <> btrim(p_message_id) THEN
    RAISE EXCEPTION 'email delivery lookup requires a non-empty, trimmed message id'
      USING ERRCODE = '22023';
  END IF;

  -- A nil tenant makes tenant_isolation match nothing, so only the lookup policy can admit rows.
  PERFORM pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
  PERFORM pg_catalog.set_config('app.email_delivery_message', p_message_id, true);

  RETURN QUERY
  SELECT DISTINCT delivery.school_id
  FROM app.email_deliveries AS delivery
  WHERE delivery.message_id = p_message_id;

  PERFORM pg_catalog.set_config('app.school_id', COALESCE(previous_school, ''), true);
  PERFORM pg_catalog.set_config('app.email_delivery_message', COALESCE(previous_message, ''), true);
END
$function$;

ALTER FUNCTION app.resolve_email_delivery_schools(text) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.resolve_email_delivery_schools(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_email_delivery_schools(text) TO studafy_app;

-- The lookup is served by the existing partial index idx_email_deliveries_message_id.

RESET ROLE;
