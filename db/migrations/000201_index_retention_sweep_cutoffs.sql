-- Indexes for the data retention sweep's new categories
-- (apps/workers/src/queues/maintenance/data-retention-sweep.ts, docs/modules/data-retention.md).
--
-- The sweep now deletes, per school and 1000 rows per statement, rows older than a cutoff from
-- tables that nothing ever cleaned. Each batch is "this school's rows older than X", and on these
-- four tables no index answers that:
--
--   app.outbox_events                  finished events 14 days after created_at. Its indexes are the
--                                      primary key on id and three partial (school_id, id) indexes
--                                      over the *unfinished* rows of each consumer -- the opposite set.
--   app.notification_dispatch_logs     12 months after created_at. Its (school_id, recipient_id,
--                                      created_at) index puts the date behind the recipient.
--   app.notification_idempotency_keys  12 months after reserved_at. Only the unresolved rows
--                                      (dispatched_at IS NULL) have a reserved_at index.
--   app.email_events                   12 months after received_at. Global, no index but the
--                                      primary key and the (message_id, event_type) dedup key.
--
-- Without them each batch would read the school's whole history (or, for email_events, the whole
-- table) to find 1000 old rows, every day. With them each batch is a range scan of exactly the rows
-- it deletes, and the indexes stay as small as the tables now do.
--
-- Tables the sweep also reaches but that need nothing here: email_deliveries already has
-- (school_id, created_at) (000077); refresh_tokens is walked by family on (school_id, family_id)
-- (000007); notification_dead_letters and attendance_alert_logs are small (one row per failed job,
-- one per absence alert) and are read through their school-leading indexes.
--
-- Built inside this transaction: the runner allows one CONCURRENTLY statement per file, and these
-- are four. The logs are append-mostly and written by workers, which retry. app.outbox_events is
-- also written by API requests, which wait while its index builds; the build is one pass over a
-- table that, on a young deployment, is small. The lock_timeout bounds the other risk: if a long
-- transaction holds the table, the migration gives up after 5 seconds instead of queueing every
-- writer behind it, and the deploy's migrate step is re-run later. IF NOT EXISTS lets an operator
-- who finds the outbox too large build its index first by hand, CONCURRENTLY, under the same name;
-- this migration then skips it.

SET ROLE studafy_admin;

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_outbox_events_school_created
  ON app.outbox_events (school_id, created_at);

CREATE INDEX IF NOT EXISTS idx_notification_dispatch_logs_school_created
  ON app.notification_dispatch_logs (school_id, created_at);

CREATE INDEX IF NOT EXISTS idx_notification_idempotency_keys_school_reserved
  ON app.notification_idempotency_keys (school_id, reserved_at);

CREATE INDEX IF NOT EXISTS idx_email_events_received_at
  ON app.email_events (received_at);

RESET ROLE;
