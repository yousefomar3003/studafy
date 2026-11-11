-- Automatic retention support (apps/workers/src/queues/maintenance/data-retention-sweep.ts,
-- docs/modules/data-retention.md).
--
-- 1. In-app notifications are deleted 12 months after they were created. Three logs point at the
--    inbox row with ON DELETE RESTRICT, so deleting any notification that was ever dispatched,
--    announced or raised as an attendance alert failed:
--      app.notification_dispatch_logs.notification_id   (000074)
--      app.announcement_recipients.notification_id      (000105)
--      app.attendance_alert_logs.notification_id        (000056)
--    Each link becomes ON DELETE SET NULL (notification_id): the log row -- who was told what, when --
--    stays; only the pointer to the deleted inbox row is cleared. The column list matters: the key
--    is composite (notification_id, school_id), and a bare SET NULL would also clear school_id,
--    which is NOT NULL. Referential actions run as the referencing table's owner and bypass RLS, so
--    the sweep needs no extra policy.
--
--    ck_announcement_recipients_notified_pair required notified_at and notification_id to be set
--    together. It now requires only that a notification_id comes with notified_at, so "notified,
--    and the inbox row has since expired" is representable. The reach stats count notified_at,
--    which is unchanged.
--
--    On app.attendance_alert_logs a null notification_id on a row younger than the 12-month window
--    still means "claimed but never notified" (attendance-alert.worker.ts); on an older row it may
--    also mean the notification expired.
--
-- 2. Indexes on the three link columns. Every delete of a notification checks -- and now updates --
--    the rows that point at it; without an index that is one sequential scan of each log per deleted
--    notification. Partial on NOT NULL: suppressed dispatches and push/email rows carry no link, and
--    the referential query's equality predicate implies the index predicate. Built inside this
--    migration's transaction (the runner allows one CONCURRENTLY statement per file only); the logs
--    are append-mostly and the build is a single pass.
--
-- 3. app.data_subject_requests.export_deleted_at: when the stored export bundle
--    (dsr-exports/<school>/<request>/...) was deleted, 30 days after the request finished. The row
--    itself is the compliance record and stays, storage_key included:
--    ck_data_subject_requests_terminal_state requires a completed export to keep its storage_key, so
--    the key cannot be cleared. This column records that the objects behind it are gone, so the
--    sweep does not revisit the request and the API stops handing out a download link.

SET ROLE studafy_admin;

-- Validating a foreign key scans the referencing table, and forced RLS applies that scan's
-- tenant_isolation predicate even to the owner (see 000179). Each key below replaces one with the
-- same columns and target, dropped in this same transaction, so every existing row already
-- satisfies it and the nil tenant's empty scan loses nothing.
SELECT pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

-- 1 -------------------------------------------------------------------------------------------------
ALTER TABLE app.notification_dispatch_logs
  DROP CONSTRAINT fk_notification_dispatch_logs_notification,
  ADD CONSTRAINT fk_notification_dispatch_logs_notification
    FOREIGN KEY (notification_id, school_id) REFERENCES app.notifications (id, school_id)
    ON UPDATE RESTRICT ON DELETE SET NULL (notification_id);

ALTER TABLE app.announcement_recipients
  DROP CONSTRAINT fk_announcement_recipients_notification,
  ADD CONSTRAINT fk_announcement_recipients_notification
    FOREIGN KEY (notification_id, school_id) REFERENCES app.notifications (id, school_id)
    ON UPDATE RESTRICT ON DELETE SET NULL (notification_id),
  DROP CONSTRAINT ck_announcement_recipients_notified_pair,
  ADD CONSTRAINT ck_announcement_recipients_notified_pair CHECK (
    notification_id IS NULL OR notified_at IS NOT NULL
  );

ALTER TABLE app.attendance_alert_logs
  DROP CONSTRAINT fk_attendance_alert_logs_notification,
  ADD CONSTRAINT fk_attendance_alert_logs_notification
    FOREIGN KEY (notification_id, school_id) REFERENCES app.notifications (id, school_id)
    ON UPDATE RESTRICT ON DELETE SET NULL (notification_id);

-- 2 -------------------------------------------------------------------------------------------------
CREATE INDEX idx_notification_dispatch_logs_notification
  ON app.notification_dispatch_logs (notification_id, school_id)
  WHERE notification_id IS NOT NULL;
CREATE INDEX idx_announcement_recipients_notification
  ON app.announcement_recipients (notification_id, school_id)
  WHERE notification_id IS NOT NULL;
CREATE INDEX idx_attendance_alert_logs_notification
  ON app.attendance_alert_logs (notification_id, school_id)
  WHERE notification_id IS NOT NULL;

-- 3 -------------------------------------------------------------------------------------------------
ALTER TABLE app.data_subject_requests
  ADD COLUMN export_deleted_at timestamptz(3),
  -- Only an export has a bundle, and only a finished one (completed or failed: a failed export can
  -- leave partial objects behind) can have had it deleted.
  ADD CONSTRAINT ck_data_subject_requests_export_deleted CHECK (
    export_deleted_at IS NULL
    OR (request_type = 'export' AND completed_at IS NOT NULL AND export_deleted_at >= completed_at)
  );

COMMENT ON COLUMN app.data_subject_requests.export_deleted_at IS
  'When the stored export bundle was deleted by the data retention sweep (30 days after completion). storage_key is kept as the record of where it was.';

RESET ROLE;
