-- An expense's attachment must be one of its own school's storage objects.
--
-- POST/PATCH /api/finance/expenses accepted `attachment_storage_key` from the request body and stored
-- it without checking which school the key belongs to, so another school's object key could be saved
-- and then signed for download. The API now refuses such keys (403 STORAGE_KEY_FORBIDDEN) and never
-- signs a stored key from another school. This is the database floor under that: the key's second
-- segment (`<category>/<schoolId>/<objectId>/<filename>`, docs/runbooks/storage-conventions.md) must
-- be the row's own school.
--
-- NOT VALID: enforced for every new or updated row, without failing this migration on a row saved
-- before the fix. Such rows are already never signed by the API.

SET ROLE studafy_admin;

ALTER TABLE app.expense_cache
  ADD CONSTRAINT ck_expense_cache_attachment_key_school CHECK (
    attachment_storage_key IS NULL
    OR split_part(attachment_storage_key, '/', 2) = school_id::text
  ) NOT VALID;

RESET ROLE;
