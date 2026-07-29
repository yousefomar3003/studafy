-- studafy:migration transaction=off
-- Extend app.finance_entity_type with the two DocTypes ST-119 crosswalks (fee structures and the
-- fee categories they are built from). The enum has carried 'invoice', 'payment' and
-- 'fee_schedule' since 000015; app.erpnext_id_mappings keys off it.
--
-- Non-transactional, and therefore idempotent, for a specific reason: PostgreSQL will not let a
-- value added by ALTER TYPE ... ADD VALUE be *used* elsewhere in the same transaction. Splitting
-- the enum extension into its own non-transactional migration is what lets 000059 and the runtime
-- INSERTs reference 'fee_structure' at all. IF NOT EXISTS supplies the idempotency the
-- transaction=off escape hatch requires -- a re-run after a partial failure must be a no-op, since
-- there is no transaction to roll back.
--
-- No SET ROLE here: ALTER TYPE must run as the type's owner, which is the migration role already.

ALTER TYPE app.finance_entity_type ADD VALUE IF NOT EXISTS 'fee_structure';
ALTER TYPE app.finance_entity_type ADD VALUE IF NOT EXISTS 'fee_category';
