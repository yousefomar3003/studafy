-- QA-044: the school's own "today".
--
-- Finance and billing dated postings with the server's UTC date and compared due dates with
-- CURRENT_DATE (the session's UTC date). Studafy's schools are UTC+1 to UTC+4, so a payment taken
-- at 01:30 in Riyadh was dated the previous day and overdue flags flipped hours late. This returns
-- the date at `at` (default: now) in the armed school's timezone (app.school_settings.timezone),
-- falling back to UTC when the school has no settings row or no school is armed.
--
-- SECURITY INVOKER: it reads school_settings under the caller's own tenant isolation, so it can
-- only ever see the armed school's row. Forward-only and additive: one function.

SET ROLE studafy_admin;

CREATE FUNCTION app.school_today(at timestamptz DEFAULT CURRENT_TIMESTAMP)
RETURNS date
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT (at AT TIME ZONE coalesce(
    (
      SELECT s.timezone
      FROM app.school_settings AS s
      WHERE s.school_id = nullif(pg_catalog.current_setting('app.school_id', true), '')::uuid
    ),
    'UTC'
  ))::date
$function$;

ALTER FUNCTION app.school_today(timestamptz) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.school_today(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.school_today(timestamptz) TO studafy_app;

RESET ROLE;
