-- An expense's attachment must be one of its own school's storage objects.
--
-- POST/PATCH /api/finance/expenses accepted `attachment_storage_key` from the request body and stored
-- it without checking which school the key belongs to, so another school's object key could be saved
-- and then signed for download. The API now refuses such keys (403 STORAGE_KEY_FORBIDDEN) and never
-- signs a stored key from another school. This trigger is the database floor under that: when a row
-- is written with a key, or its key or school changes, the key's second segment
-- (`<category>/<schoolId>/<objectId>/<filename>`, docs/runbooks/storage-conventions.md) must be the
-- row's own school.
--
-- A trigger rather than a CHECK constraint on purpose. A row saved before this fix may still hold a
-- foreign key; a CHECK (even NOT VALID) would be re-evaluated on every UPDATE of such a row, so the
-- upload scanner could never mark it `failed` (scan-upload.worker.ts). Firing only on INSERT and on
-- UPDATE OF the key or the school leaves those rows updatable, while no new foreign key can be
-- written. They are never signed by the API either way.

SET ROLE studafy_admin;

CREATE FUNCTION app.expense_cache_check_attachment_key_school()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.attachment_storage_key IS NOT NULL
    AND split_part(NEW.attachment_storage_key, '/', 2) IS DISTINCT FROM NEW.school_id::text
  THEN
    RAISE EXCEPTION 'expense attachment key must belong to the expense''s school'
      USING ERRCODE = 'check_violation', TABLE = 'expense_cache', SCHEMA = 'app';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_expense_cache_attachment_key_school
  BEFORE INSERT OR UPDATE OF attachment_storage_key, school_id
  ON app.expense_cache
  FOR EACH ROW EXECUTE FUNCTION app.expense_cache_check_attachment_key_school();

REVOKE ALL ON FUNCTION app.expense_cache_check_attachment_key_school() FROM PUBLIC;

RESET ROLE;
