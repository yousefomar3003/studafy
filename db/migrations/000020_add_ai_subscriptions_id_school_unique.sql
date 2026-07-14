-- Adds the house tenant-checked candidate key on app.ai_subscriptions, which migration 000016
-- omitted because no child table referenced it at the time. Migration 000021's
-- app.ai_usage_meters table needs a composite FK (ai_subscription_id, school_id) ->
-- app.ai_subscriptions (id, school_id), and PostgreSQL requires a matching UNIQUE constraint on
-- the referenced table. This is the same (id, school_id) pattern present on every other tenant
-- table in the schema (students, materials, assignments, etc.).

SET ROLE studafy_admin;

ALTER TABLE app.ai_subscriptions
  ADD CONSTRAINT uq_ai_subscriptions_id_school UNIQUE (id, school_id);

RESET ROLE;
