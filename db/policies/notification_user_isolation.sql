-- Restrictive user-isolation policies for the notification model.
--
-- These policies AND with the permissive tenant_isolation policy already installed on all three
-- tables by app.apply_tenant_isolation. A row is reachable only when both boundaries agree: the
-- school matches app.school_id, and the owning user matches app.user_id. Tenant isolation stays the
-- outer boundary; this is the inner one.
--
-- Prerequisites:
--   1. app.apply_tenant_isolation('app', <table>) has been called for each table.
--   2. app.current_user_id() exists and is granted EXECUTE to studafy_app (000014).
--   3. The application sets both session variables per transaction:
--        SELECT set_config('app.school_id', $school_id, true);
--        SELECT set_config('app.user_id', $user_id, true);
--      Neither has a default. An unset or malformed GUC raises rather than matching rows, so a
--      caller that forgets the context reads nothing instead of reading everything.
--
-- Why these name studafy_app instead of PUBLIC
--
-- A restrictive policy applies only to the roles it names. Naming the runtime role fences it
-- completely while leaving a studafy_admin-owned SECURITY DEFINER function able to perform the two
-- operations that are legitimately cross-user, and which FORCE ROW LEVEL SECURITY would otherwise
-- make unreachable for every role including the table owner:
--
--   app.seed_default_notification_preferences()  -- an administrator activating a user must be able
--                                                   to write that user's default preferences
--   app.claim_device_token(text)                 -- a device changing hands must be able to revoke
--                                                   the previous owner's route to the same token
--
-- Both are defined in 000017, are confined to current_setting('app.school_id'), and are the only
-- grants of that capability. studafy_admin is NOLOGIN (000002), so there is no other way in.
--
-- Why app.notifications has no restrictive INSERT policy
--
-- A notification is written *for* someone by someone else -- a teacher posting a grade notifies a
-- student. A self-only WITH CHECK on INSERT would therefore make the feature unbuildable. INSERT is
-- confined by tenant_isolation's WITH CHECK alone (same school), and authorization for sending is
-- the application's job via the existing notification:send permission. SELECT, UPDATE and DELETE are
-- strictly self-only, and the UPDATE policy carries WITH CHECK as well as USING so a recipient can
-- mark their own notification read but cannot re-address the row to another user.

CREATE POLICY notifications_owner_select ON app.notifications
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (user_id = app.current_user_id());

CREATE POLICY notifications_owner_update ON app.notifications
  AS RESTRICTIVE FOR UPDATE TO studafy_app
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

CREATE POLICY notifications_owner_delete ON app.notifications
  AS RESTRICTIVE FOR DELETE TO studafy_app
  USING (user_id = app.current_user_id());

CREATE POLICY notification_preferences_owner ON app.notification_preferences
  AS RESTRICTIVE FOR ALL TO studafy_app
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

CREATE POLICY user_devices_owner ON app.user_devices
  AS RESTRICTIVE FOR ALL TO studafy_app
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());
