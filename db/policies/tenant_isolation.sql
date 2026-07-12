-- Canonical policy template for a normalized school-owned table.
--
-- Copy this call into the same ordered migration that creates the table, after its constraints and
-- deliberate school-leading indexes. Replace future_tenant_table with the real table name.
SELECT app.apply_tenant_isolation('app', 'future_tenant_table');

-- The helper installs exactly this permissive policy. PUBLIC grants no privileges; it means every
-- role that already has table privileges, including the forced table owner, remains subject to RLS.
--
-- CREATE POLICY tenant_isolation ON app.future_tenant_table
--   AS PERMISSIVE
--   FOR ALL
--   TO PUBLIC
--   USING (school_id = current_setting('app.school_id')::uuid)
--   WITH CHECK (school_id = current_setting('app.school_id')::uuid);
