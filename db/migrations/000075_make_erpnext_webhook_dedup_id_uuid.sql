-- Re-keys app.erpnext_webhook_dedup.id from a bigint identity to a uuid, so the webhook's audit
-- record can reference the dedup row truthfully.
--
-- The ERPNext webhook audits its dedup insert with emitAuditLog, which writes audit_logs.target_id
-- as a uuid (apps/api/src/middleware/auditEmitter.ts casts `${entry.targetId}::uuid`; the column
-- itself is uuid NOT NULL, 000018). Before this migration, dedupResult[0].id was a bigint identity,
-- so String(dedupResult[0].id) was a number and the cast threw `invalid input syntax for type
-- uuid` -- every mapped webhook event rolled back with a 500, taking the outbox_events insert with
-- it. Every other audited target table in this schema uses a uuid PK (000004's convention), so the
-- dedup table's bigint id was the outlier; this migration aligns it.
--
-- Safe to re-key in place: nothing else references the id (no foreign keys to it; the uniqueness
-- guarantee lives on (school_id, event_id); the relay reads app.outbox_events, not this). The app
-- never supplies the id on INSERT (identity columns forbid it, and the insert at
-- apps/api/src/erpnext/webhook.ts omits it), so the identity default is replaced by gen_random_uuid().

SET ROLE studafy_admin;

-- Separate statements: a single multi-action ALTER would validate the type change against the
-- still-present identity and fail with "identity column type must be smallint, integer, or bigint".
ALTER TABLE app.erpnext_webhook_dedup ALTER COLUMN id DROP IDENTITY;

ALTER TABLE app.erpnext_webhook_dedup ALTER COLUMN id SET DATA TYPE uuid USING gen_random_uuid();

ALTER TABLE app.erpnext_webhook_dedup ALTER COLUMN id SET DEFAULT gen_random_uuid();

RESET ROLE;
