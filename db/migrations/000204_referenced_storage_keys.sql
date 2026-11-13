-- Which of a set of stored-object keys some row of the current school still points at.
--
-- The one list of every column that holds a storage key. Two callers rely on it being complete:
--   * the API, before it removes the file behind a row it just deleted or replaced
--     (apps/api/src/modules/storage/free-objects.ts) -- a key can be shared: an expense may be given
--     any permanent/ key of its own school, and a material's key is derived from its file name;
--   * the orphan sweep (apps/workers/src/queues/billing/storage-orphan-sweep.ts), which treats a
--     permanent/<school>/ object no row points at as left behind by a past delete.
-- A column missing from this list makes its live files look unreferenced, so a new column that
-- stores a key MUST be added here (apps/api/tests/storage/referenced-storage-keys.test.ts fails
-- when a key-named column is not).
--
-- SECURITY DEFINER because several of these tables narrow SELECT by role for studafy_app (message
-- images to the conversation's participants, materials to readable classes, record documents to
-- readable records), and a teacher deleting a material must still see that a finance expense
-- points at the same key. It returns only keys the caller passed in, and only for the school in
-- app.school_id: forced RLS (tenant_isolation) applies to the owner too, and every branch also
-- filters on the school explicitly.
--
-- Report, export and data-subject-request keys live outside permanent/ and are not removed by
-- either caller; they are listed anyway so the answer is complete for any key.

SET ROLE studafy_admin;

CREATE FUNCTION app.referenced_storage_keys(p_keys text[])
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  WITH school AS (SELECT current_setting('app.school_id')::uuid AS id),
  wanted AS (SELECT DISTINCT unnest(p_keys) AS key)
  SELECT w.key FROM wanted AS w, school AS s
  WHERE EXISTS (SELECT 1 FROM app.materials AS t
                WHERE t.school_id = s.id
                  AND (t.storage_key = w.key OR t.thumbnail_key = w.key OR t.preview_key = w.key))
     OR EXISTS (SELECT 1 FROM app.assignment_attachments AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.assignment_questions AS t
                WHERE t.school_id = s.id AND t.image_storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.submission_attachments AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.message_attachments AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.expense_cache AS t
                WHERE t.school_id = s.id AND t.attachment_storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.license_payment_receipts AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.license_payments AS t
                WHERE t.school_id = s.id AND t.receipt_storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.record_documents AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.student_imports AS t
                WHERE t.school_id = s.id AND t.source_storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.report_export_jobs AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.progress_report_jobs AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.audit_export_jobs AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
     OR EXISTS (SELECT 1 FROM app.finance_report_jobs AS t
                WHERE t.school_id = s.id AND t.object_key = w.key)
     OR EXISTS (SELECT 1 FROM app.data_subject_requests AS t
                WHERE t.school_id = s.id AND t.storage_key = w.key)
$function$;

COMMENT ON FUNCTION app.referenced_storage_keys(text[]) IS
  'The given keys some row of app.school_id still points at (000204). Every storage-key column is listed here.';

ALTER FUNCTION app.referenced_storage_keys(text[]) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.referenced_storage_keys(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.referenced_storage_keys(text[]) TO studafy_app;

RESET ROLE;
