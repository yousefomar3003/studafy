-- Malware-scan every user upload other people can download, not only study materials (F-14).
--
-- Until now only app.materials went through ClamAV (000088): submissions, assignment files, question
-- pictures, message images, record documents, expense and license receipts, school application
-- proofs and student import files were served the moment they were promoted. Each of those now
-- carries an app.upload_scan_status, set by the API to 'scanning' when the file lands and flipped by
-- the workers' file-scan queue (scan-upload job, apps/workers/src/queues/scan/scan-upload.worker.ts)
-- to 'clean', 'quarantined' (copied to quarantine/, the served copy deleted) or 'failed' (no verdict
-- after every retry). Downloads are issued only for 'clean' and 'unscanned'.
--
-- Files uploaded before this migration are 'unscanned': they stay downloadable, because refusing
-- every existing submission, record document and message image until a backfill finished would break
-- schools on deploy day for a risk that predates the change. The worker accepts an 'unscanned' row
-- too, so a backfill is only a matter of enqueueing scan-upload jobs for them; an infected one is
-- then quarantined like a new upload.
--
-- Where every insert is an upload (the attachment, receipt and application tables) the column
-- default becomes 'scanning' once existing rows are backfilled, so a write path that forgets to set
-- it fails closed (not served) rather than open. Where the file is optional or attached by a later
-- UPDATE (record documents, expenses, question pictures, import sources) the default stays
-- 'unscanned' and the write that sets the key sets 'scanning' with it.
--
-- One enum for every table rather than reusing material_ingest_status: a material's lifecycle also
-- covers AI ingestion, and none of these files is ingested.
--
-- App license payment receipts (app.license_payments.receipt_storage_key) are not covered: platform
-- staff upload them and only platform staff download them, and the table's void-only trigger would
-- have to learn a second legitimate update.

SET ROLE studafy_admin;

CREATE TYPE app.upload_scan_status AS ENUM ('unscanned', 'scanning', 'clean', 'quarantined', 'failed');

COMMENT ON TYPE app.upload_scan_status IS
  'Malware scan state of an uploaded file other than a material (000192). Served only when clean or unscanned (uploaded before scanning covered it).';

-- Every insert is an upload: existing rows become 'unscanned', new ones start 'scanning'.
ALTER TABLE app.submission_attachments
  ADD COLUMN scan_status app.upload_scan_status NOT NULL DEFAULT 'unscanned';
ALTER TABLE app.submission_attachments ALTER COLUMN scan_status SET DEFAULT 'scanning';

ALTER TABLE app.assignment_attachments
  ADD COLUMN scan_status app.upload_scan_status NOT NULL DEFAULT 'unscanned';
ALTER TABLE app.assignment_attachments ALTER COLUMN scan_status SET DEFAULT 'scanning';

ALTER TABLE app.message_attachments
  ADD COLUMN scan_status app.upload_scan_status NOT NULL DEFAULT 'unscanned';
ALTER TABLE app.message_attachments ALTER COLUMN scan_status SET DEFAULT 'scanning';

ALTER TABLE app.license_payment_receipts
  ADD COLUMN scan_status app.upload_scan_status NOT NULL DEFAULT 'unscanned';
ALTER TABLE app.license_payment_receipts ALTER COLUMN scan_status SET DEFAULT 'scanning';

ALTER TABLE app.school_applications
  ADD COLUMN proof_scan_status app.upload_scan_status NOT NULL DEFAULT 'unscanned';
ALTER TABLE app.school_applications ALTER COLUMN proof_scan_status SET DEFAULT 'scanning';

-- The file is optional or attached later: the write that sets the key sets 'scanning'.
ALTER TABLE app.record_documents
  ADD COLUMN scan_status app.upload_scan_status NOT NULL DEFAULT 'unscanned';

ALTER TABLE app.expense_cache
  ADD COLUMN attachment_scan_status app.upload_scan_status NOT NULL DEFAULT 'unscanned';

ALTER TABLE app.assignment_questions
  ADD COLUMN image_scan_status app.upload_scan_status NOT NULL DEFAULT 'unscanned';

ALTER TABLE app.student_imports
  ADD COLUMN source_scan_status app.upload_scan_status NOT NULL DEFAULT 'unscanned';

COMMENT ON COLUMN app.submission_attachments.scan_status IS 'Malware scan state of the file (000192).';
COMMENT ON COLUMN app.assignment_attachments.scan_status IS 'Malware scan state of the file (000192).';
COMMENT ON COLUMN app.message_attachments.scan_status IS 'Malware scan state of the image (000192).';
COMMENT ON COLUMN app.license_payment_receipts.scan_status IS 'Malware scan state of the receipt file (000192).';
COMMENT ON COLUMN app.school_applications.proof_scan_status IS 'Malware scan state of the proof of ownership file (000192).';
COMMENT ON COLUMN app.record_documents.scan_status IS 'Malware scan state of the file on record (000192).';
COMMENT ON COLUMN app.expense_cache.attachment_scan_status IS 'Malware scan state of the attached receipt (000192).';
COMMENT ON COLUMN app.assignment_questions.image_scan_status IS 'Malware scan state of the question picture (000192).';
COMMENT ON COLUMN app.student_imports.source_scan_status IS 'Malware scan state of the original import file (000192).';

-- A report reviewer reads a reported thread's images through this SECURITY DEFINER lookup. Same
-- signature as 000136 (so CREATE OR REPLACE keeps its owner and grant); an image that is not
-- servable comes back without its key, so no download URL is ever minted for it.
CREATE OR REPLACE FUNCTION app.message_report_attachment_objects(p_report_id uuid)
RETURNS TABLE (
  report_message_id uuid,
  attachment_id uuid,
  attachment_position smallint,
  mime_type text,
  size_bytes bigint,
  storage_key text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT rm.id, ma.id, ma.position, ma.mime_type, ma.size_bytes,
         CASE WHEN ma.scan_status IN ('clean', 'unscanned') THEN ma.storage_key END
  FROM app.message_report_messages AS rm
  JOIN app.message_report_attachments AS ra
    ON ra.school_id = rm.school_id AND ra.report_message_id = rm.id
  JOIN app.message_attachments AS ma
    ON ma.school_id = ra.school_id AND ma.id = ra.attachment_id
  WHERE rm.school_id = current_setting('app.school_id')::uuid
    AND rm.report_id = p_report_id
    AND app.current_user_can_review_message_reports()
  ORDER BY rm.position, ma.position
$function$;

RESET ROLE;
