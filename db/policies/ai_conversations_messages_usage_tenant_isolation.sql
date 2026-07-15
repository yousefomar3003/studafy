-- Reference mirror of the tenant isolation installed on app.ai_conversations, app.ai_messages, and
-- app.ai_usage_meters by migration 000021. This file is documentation: the runner only executes
-- db/migrations. It is kept faithful to the migration so a reviewer can read the security posture
-- of the AI chat and usage tracking without reading the whole migration.

-- ---------------------------------------------------------------------------------------------------
-- 1. Grants. Ordinary CRUD for the runtime role.
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE app.ai_conversations, app.ai_messages, app.ai_usage_meters FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.ai_conversations, app.ai_messages, app.ai_usage_meters TO studafy_app;

REVOKE ALL ON FUNCTION app.upsert_ai_usage_tokens(uuid, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.upsert_ai_usage_tokens(uuid, uuid, bigint) TO studafy_app;

REVOKE ALL ON FUNCTION app.delete_expired_ai_messages(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_expired_ai_messages(integer) TO studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 2. The canonical ST-034 tenant policy on all three tables.
-- ---------------------------------------------------------------------------------------------------

SELECT app.apply_tenant_isolation('app', 'ai_conversations');
SELECT app.apply_tenant_isolation('app', 'ai_messages');
SELECT app.apply_tenant_isolation('app', 'ai_usage_meters');

-- The helper enables AND forces RLS and installs exactly this policy on each table:
--
-- CREATE POLICY tenant_isolation ON app.<table>
--   AS PERMISSIVE
--   FOR ALL
--   TO PUBLIC
--   USING (school_id = current_setting('app.school_id')::uuid)
--   WITH CHECK (school_id = current_setting('app.school_id')::uuid);

-- ---------------------------------------------------------------------------------------------------
-- 3. Tenant integrity is enforced in the schema via composite foreign keys.
-- ---------------------------------------------------------------------------------------------------

-- ai_messages.conversation_id is backed by:
--   fk_ai_messages_conversation FOREIGN KEY (conversation_id, school_id)
--     REFERENCES app.ai_conversations (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT
--
-- ai_usage_meters.student_id is backed by:
--   fk_ai_usage_meters_student FOREIGN KEY (student_id, school_id)
--     REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT
--
-- ai_usage_meters.ai_subscription_id is backed by:
--   fk_ai_usage_meters_ai_subscription FOREIGN KEY (ai_subscription_id, school_id)
--     REFERENCES app.ai_subscriptions (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT
--
-- These composite references make cross-school attribute access impossible at the schema level.
-- That guarantee holds where RLS does not run: for a superuser, for a role with BYPASSRLS, and
-- inside a SECURITY DEFINER function. RLS is a row filter, not a referential guarantee, and the
-- two are not substitutes for one another -- which is why both are present.

-- ---------------------------------------------------------------------------------------------------
-- 4. Retention: app.delete_expired_ai_messages()
-- ---------------------------------------------------------------------------------------------------

-- Batch-deletes messages where expires_at < now(). The function is SECURITY INVOKER and respects
-- RLS, so it only deletes messages in the caller's current school context. The recommended
-- invocation pattern is a scheduled job that loops until the function returns 0:
--
--   LOOP
--     v_deleted := app.delete_expired_ai_messages(1000);
--     EXIT WHEN v_deleted = 0;
--     COMMIT;
--   END LOOP;
--
-- Each batch runs in its own transaction, avoiding long-held locks. The expires_at index
-- (school_id, expires_at) is the primary access path, with school_id leading for RLS pushdown.

-- ---------------------------------------------------------------------------------------------------
-- 5. Usage upsert: app.upsert_ai_usage_tokens()
-- --------------------------------------------------------------------------------------------------

-- Atomic INSERT ... ON CONFLICT DO UPDATE that increments total_tokens under row-level locking.
-- Safe for concurrent increments from multiple API workers. The CONFLICT target is the unique
-- constraint (school_id, student_id, ai_subscription_id), ensuring one row per student per billing
-- cycle. The function is SECURITY INVOKER and reads app.school_id from the transaction context.

-- ---------------------------------------------------------------------------------------------------
-- 6. cited_chunk_ids: intentional lack of FK.
-- ---------------------------------------------------------------------------------------------------

-- ai_messages.cited_chunk_ids is a uuid[], not an array of FK references. material_chunks rows
-- are deleted via CASCADE when their parent material is removed. A cited_chunk_ids value that
-- points at a deleted chunk is stale but harmless: the citation is informational (rendered as
-- "page 12, 'Photosynthesis'"), and a missing chunk does not break the message or the query.
-- Enabling FK integrity on array elements would require a trigger or a separate join table, both
-- disproportionate to the benefit. The array is validated as NOT NULL at the column level.
