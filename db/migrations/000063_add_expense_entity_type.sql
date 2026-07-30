-- studafy:migration transaction=off
-- Extend app.finance_entity_type with the 'expense' value for expense gateway.
-- Non-transactional: ALTER TYPE cannot run inside a transaction block that uses the type.

ALTER TYPE app.finance_entity_type ADD VALUE IF NOT EXISTS 'expense';
