-- SECURITY DEFINER function to insert a school without exposing the admin role to the API layer.
--
-- The API runtime authenticates as studafy_app via PgBouncer and never holds admin credentials.
-- Because app.schools is owned by studafy_admin and studafy_app holds only SELECT, the API
-- cannot INSERT directly.  This function runs with the privileges of its owner (studafy_admin)
-- and is callable by studafy_app.

SET ROLE studafy_admin;

CREATE FUNCTION app.register_school(
  p_slug text,
  p_name text,
  p_email text,
  p_normalized_email text,
  p_country_id uuid,
  p_default_currency_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app
AS $function$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO app.schools (
    slug, name, email, normalized_email,
    status, country_id, default_currency_id
  ) VALUES (
    p_slug, p_name, p_email, p_normalized_email,
    'registered'::app.school_status, p_country_id, p_default_currency_id
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

ALTER FUNCTION app.register_school(text, text, text, text, uuid, uuid)
  OWNER TO studafy_admin;

REVOKE ALL ON FUNCTION app.register_school(text, text, text, text, uuid, uuid)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.register_school(text, text, text, text, uuid, uuid)
  TO studafy_app;

RESET ROLE;
