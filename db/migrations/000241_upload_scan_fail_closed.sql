-- QA-055: an upload whose scan status was forgotten fails closed, and receipts are scanned too.
--
-- 1. Four tables keep the servable 'unscanned' default from 000192, because their file is optional
--    or attached by a later UPDATE: record_documents, expense_cache, assignment_questions and
--    student_imports. A write path that set the key and forgot to set 'scanning' served the file
--    unscanned. A BEFORE trigger now turns 'unscanned' into 'scanning' whenever a key is written,
--    so the omission fails closed. Rows written before 000192 keep 'unscanned' (they are not
--    touched), and the workers' sweep now scans them.
--
-- 2. Two receipt files were never scan targets and were served directly: license_payments and
--    manual_grants.receipt_storage_key. Each gets a receipt_scan_status column with the same
--    trigger. Platform staff upload and download them, but a receipt is a file from outside the
--    company, opened on a staff machine.
--
-- 3. license_payments may only be voided, once (000165). The scan worker's status update is now
--    the one other legitimate change: an update touching nothing but receipt_scan_status (and
--    updated_at) passes.

SET ROLE studafy_admin;

-- 1. The trigger. TG_ARGV: the key column, then the status column.
CREATE FUNCTION app.upload_scan_fail_closed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  new_row jsonb := pg_catalog.to_jsonb(NEW);
  new_key text := new_row ->> TG_ARGV[0];
BEGIN
  IF new_key IS NOT NULL
     AND new_row ->> TG_ARGV[1] = 'unscanned'
     AND (TG_OP = 'INSERT' OR new_key IS DISTINCT FROM pg_catalog.to_jsonb(OLD) ->> TG_ARGV[0])
  THEN
    NEW := pg_catalog.jsonb_populate_record(
      NEW, pg_catalog.jsonb_build_object(TG_ARGV[1], 'scanning')
    );
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION app.upload_scan_fail_closed() FROM PUBLIC;

-- 2. The receipt columns. Existing receipts are 'unscanned' (servable, swept); new ones 'scanning'.
ALTER TABLE app.license_payments
  ADD COLUMN receipt_scan_status app.upload_scan_status NOT NULL DEFAULT 'unscanned';
ALTER TABLE app.manual_grants
  ADD COLUMN receipt_scan_status app.upload_scan_status NOT NULL DEFAULT 'unscanned';

COMMENT ON COLUMN app.license_payments.receipt_scan_status IS
  'Malware scan state of the receipt file (000241).';
COMMENT ON COLUMN app.manual_grants.receipt_scan_status IS
  'Malware scan state of the receipt file (000241).';

CREATE TRIGGER trg_record_documents_scan_fail_closed
  BEFORE INSERT OR UPDATE OF storage_key ON app.record_documents
  FOR EACH ROW EXECUTE FUNCTION app.upload_scan_fail_closed('storage_key', 'scan_status');
CREATE TRIGGER trg_expense_cache_scan_fail_closed
  BEFORE INSERT OR UPDATE OF attachment_storage_key ON app.expense_cache
  FOR EACH ROW EXECUTE FUNCTION
    app.upload_scan_fail_closed('attachment_storage_key', 'attachment_scan_status');
CREATE TRIGGER trg_assignment_questions_scan_fail_closed
  BEFORE INSERT OR UPDATE OF image_storage_key ON app.assignment_questions
  FOR EACH ROW EXECUTE FUNCTION
    app.upload_scan_fail_closed('image_storage_key', 'image_scan_status');
CREATE TRIGGER trg_student_imports_scan_fail_closed
  BEFORE INSERT OR UPDATE OF source_storage_key ON app.student_imports
  FOR EACH ROW EXECUTE FUNCTION
    app.upload_scan_fail_closed('source_storage_key', 'source_scan_status');
CREATE TRIGGER trg_license_payments_scan_fail_closed
  BEFORE INSERT OR UPDATE OF receipt_storage_key ON app.license_payments
  FOR EACH ROW EXECUTE FUNCTION
    app.upload_scan_fail_closed('receipt_storage_key', 'receipt_scan_status');
CREATE TRIGGER trg_manual_grants_scan_fail_closed
  BEFORE INSERT OR UPDATE OF receipt_storage_key ON app.manual_grants
  FOR EACH ROW EXECUTE FUNCTION
    app.upload_scan_fail_closed('receipt_storage_key', 'receipt_scan_status');

-- 3. Void-only, with the scan verdict as the one other change a payment row accepts.
CREATE OR REPLACE FUNCTION app.license_payments_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF (pg_catalog.to_jsonb(NEW) - 'receipt_scan_status' - 'updated_at')
     = (pg_catalog.to_jsonb(OLD) - 'receipt_scan_status' - 'updated_at')
  THEN
    RETURN NEW;
  END IF;
  IF OLD.voided_at IS NOT NULL
     OR NEW.voided_at IS NULL
     OR (NEW.invoice_id, NEW.amount_minor, NEW.currency_id, NEW.received_at, NEW.bank_reference,
         NEW.method, NEW.receipt_storage_key, NEW.recorded_by, NEW.note)
        IS DISTINCT FROM
        (OLD.invoice_id, OLD.amount_minor, OLD.currency_id, OLD.received_at, OLD.bank_reference,
         OLD.method, OLD.receipt_storage_key, OLD.recorded_by, OLD.note)
  THEN
    RAISE EXCEPTION 'a payment can only be voided, once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_license_payments_void_only',
            TABLE = 'license_payments', SCHEMA = 'app';
  END IF;
  RETURN NEW;
END
$function$;

RESET ROLE;
