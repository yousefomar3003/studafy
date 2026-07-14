-- Creates the user-scoped notification model: app.notifications (the in-app inbox),
-- app.notification_preferences (one row per user x notification type x channel), and
-- app.user_devices (push-token registry for FCM targeting).
--
-- Depends on 000004 (app.schools), 000006 (app.apply_tenant_isolation), 000007 (app.users,
-- app.user_status), and 000014 (app.current_user_id).
--
-- Vocabulary is not invented here. app.notification_type mirrors NOTIFICATION_TYPES in
-- packages/constants/src/notifications.ts label-for-label, and app.notification_channel mirrors the
-- three channels apps/workers/docs/queue-catalog.md already names for the `notifications` queue
-- (email, push, in-app). The paired test asserts both label lists against pg_enum, so the TypeScript
-- constants and these types cannot drift apart silently.
--
-- Two rows of security, not one. The canonical permissive tenant_isolation policy (000006) fences
-- every row to its school. On top of it, each table takes a RESTRICTIVE policy fencing rows to their
-- owning user via app.current_user_id(); restrictive policies AND with the permissive one, so a row
-- is reachable only when both the school and the user match. This is the same shape 000014
-- introduced for teacher_evaluations, and the reason all three tables carry school_id as well as
-- user_id: apply_tenant_isolation requires a NOT NULL school_id with a single-column foreign key to
-- app.schools, and the tenant boundary remains the outer one.
--
-- The restrictive policies name studafy_app rather than PUBLIC, which is load-bearing rather than
-- cosmetic. A restrictive policy applies only to the roles it names, so scoping them to the runtime
-- role leaves exactly two legitimately cross-user operations reachable from a studafy_admin-owned
-- SECURITY DEFINER function: seeding a newly activated user's preferences, and revoking a device
-- token that has moved to a different owner. Neither is expressible any other way, because
-- FORCE ROW LEVEL SECURITY subjects even the table owner to its own policies. studafy_admin is
-- NOLOGIN (000002), so those two functions are the only paths to that capability, and both are
-- narrow, tenant-checked, and audited here.
--
-- INSERT on app.notifications is deliberately left tenant-scoped rather than user-scoped: a
-- notification is, by definition, written for someone other than its writer -- a teacher posting a
-- grade notifies a student -- so a self-only WITH CHECK on INSERT would make the feature
-- unbuildable. SELECT, UPDATE, and DELETE remain strictly self-only, and the UPDATE policy's
-- WITH CHECK additionally prevents re-pointing an existing row at another user. Authorization for
-- *sending* is the application's job and the permission already exists
-- (notification:send, packages/constants/src/permissions.ts). See docs/database/notifications-data-model.md.

SET ROLE studafy_admin;

CREATE TYPE app.notification_type AS ENUM (
  'ASSIGNMENT_DUE_SOON', 'GRADE_POSTED', 'ENROLLMENT_APPROVED', 'COURSE_PUBLISHED',
  'DISCUSSION_REPLY', 'STUDY_GROUP_INVITE', 'CERTIFICATE_ISSUED', 'SUPPORT_MESSAGE'
);
CREATE TYPE app.notification_channel AS ENUM ('in_app', 'email', 'push');
CREATE TYPE app.device_platform AS ENUM ('ios', 'android', 'web');

-- The in-app inbox: one row per delivered notification per recipient. read_at IS NULL means unread;
-- there is no separate boolean, because a flag plus a timestamp would be two representations of one
-- fact and could disagree.
--
-- metadata is the deep-link target and carries entity identifiers only (e.g. the assignment id a
-- GRADE_POSTED notification points at), never a copy of the referenced entity's text. JSONB is used
-- here for the reason the normalization standard permits it -- the payload shape genuinely varies by
-- notification_type and is not stable relational structure -- and it is constrained to an object so
-- it cannot degrade into a scalar or an array of loosely typed items.
CREATE TABLE app.notifications (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_notifications PRIMARY KEY,
  school_id uuid NOT NULL,
  user_id uuid NOT NULL,
  notification_type app.notification_type NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_notifications_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_notifications_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_notifications_title CHECK (title = btrim(title) AND title <> ''),
  CONSTRAINT ck_notifications_body CHECK (body = btrim(body) AND body <> ''),
  CONSTRAINT ck_notifications_metadata CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT ck_notifications_read_at CHECK (read_at IS NULL OR read_at >= created_at),
  CONSTRAINT ck_notifications_timestamps CHECK (updated_at >= created_at)
);

-- One row per (user, notification_type, channel). Modeled as rows rather than as a wide table of
-- boolean columns (email_grades, push_grades, ...) so that adding a type or a channel is an enum
-- change, not a schema change, and so that no column is a repeating group.
--
-- The primary key is the natural key exactly: enabled is the only non-key attribute and depends on
-- all three of its components -- whether a user wants GRADE_POSTED by email says nothing about
-- whether they want it by push. There is no surrogate id, because there is nothing for one to
-- identify that the natural key does not already identify uniquely.
CREATE TABLE app.notification_preferences (
  school_id uuid NOT NULL,
  user_id uuid NOT NULL,
  notification_type app.notification_type NOT NULL,
  channel app.notification_channel NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_notification_preferences PRIMARY KEY (user_id, notification_type, channel),
  CONSTRAINT fk_notification_preferences_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_notification_preferences_user FOREIGN KEY (user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_notification_preferences_timestamps CHECK (updated_at >= created_at)
);

-- The push-token registry. revoked_at IS NULL means the route is live; rows are soft-revoked rather
-- than deleted so a token that moves between users leaves a trail and so a re-registering device
-- reactivates its existing row instead of accumulating duplicates.
--
-- fcm_token is unique *per user*, not per school. A per-school unique constraint would be the
-- stronger anti-duplicate-route guarantee on paper, but it is unusable under forced RLS: when a
-- device changes hands, user B's INSERT would raise 23505 against a row owned by user A that B can
-- neither see nor delete, and there is no recovery from inside B's session. Ownership transfer is
-- therefore an explicit, privileged step -- app.claim_device_token below -- and the per-user
-- constraint keeps ordinary re-registration a plain, conflict-free upsert.
CREATE TABLE app.user_devices (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_user_devices PRIMARY KEY,
  school_id uuid NOT NULL,
  user_id uuid NOT NULL,
  fcm_token text NOT NULL,
  platform app.device_platform NOT NULL,
  last_seen timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_user_devices_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_user_devices_user_token UNIQUE (user_id, fcm_token),
  CONSTRAINT fk_user_devices_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_user_devices_user FOREIGN KEY (user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_user_devices_fcm_token CHECK (fcm_token = btrim(fcm_token) AND fcm_token <> ''),
  CONSTRAINT ck_user_devices_last_seen CHECK (last_seen >= created_at),
  CONSTRAINT ck_user_devices_revoked_at CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT ck_user_devices_timestamps CHECK (updated_at >= created_at)
);

-- Seeds the full preference matrix (every notification_type x every notification_channel, enabled)
-- the first time a user reaches the 'active' status, whether that is at INSERT or at a later
-- transition out of 'invited' or 'suspended'. Driven off enum_range, so a future migration that adds
-- a notification type or channel does not have to be taught about this function.
--
-- SECURITY DEFINER is required, not decorative: activation is routinely performed by an
-- administrator, so app.user_id during this trigger is the *acting* user, not the new one, and an
-- invoker-rights insert would be rejected by the restrictive self-only policy below. Running as the
-- owner steps outside that studafy_app-scoped policy while remaining subject to the permissive
-- tenant_isolation policy, which still holds every seeded row to NEW.school_id -- the same school
-- the user INSERT itself had to be authorized for. ON CONFLICT DO NOTHING makes re-activation
-- idempotent and preserves any preference the user has already turned off.
CREATE FUNCTION app.seed_default_notification_preferences()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  INSERT INTO app.notification_preferences (school_id, user_id, notification_type, channel, enabled)
  SELECT NEW.school_id, NEW.id, notification_type, channel, true
  FROM unnest(enum_range(NULL::app.notification_type)) AS notification_type
  CROSS JOIN unnest(enum_range(NULL::app.notification_channel)) AS channel
  ON CONFLICT ON CONSTRAINT pk_notification_preferences DO NOTHING;

  RETURN NULL;
END
$function$;

ALTER FUNCTION app.seed_default_notification_preferences() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.seed_default_notification_preferences() FROM PUBLIC, studafy_app;

CREATE TRIGGER trg_users_seed_notification_preferences
AFTER INSERT OR UPDATE OF status ON app.users
FOR EACH ROW
WHEN (NEW.status = 'active')
EXECUTE FUNCTION app.seed_default_notification_preferences();

-- Soft-revokes any *other* user's live registration of the same token, within the caller's school,
-- and reports how many rows it revoked. The device-registration path calls this immediately before
-- upserting its own row, which is what makes uq_user_devices_user_token safe to rely on: after this
-- returns, no other user in the school is still routing to that token.
--
-- SECURITY DEFINER for the same reason as the seeding trigger -- the rows it must touch belong to
-- another user and are invisible to studafy_app under the restrictive policy. Its own reach is
-- bounded three ways: it only ever sets revoked_at (it cannot read, move, or delete a row), it is
-- confined to current_setting('app.school_id') so it cannot cross a tenant boundary, and it excludes
-- the caller's own rows so it cannot be used to revoke oneself by accident.
CREATE FUNCTION app.claim_device_token(target_token text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  revoked_count integer;
BEGIN
  IF target_token IS NULL OR btrim(target_token) = '' THEN
    RAISE EXCEPTION 'device token must be non-empty'
      USING ERRCODE = '22023';
  END IF;

  UPDATE app.user_devices
  SET revoked_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE fcm_token = target_token
    AND school_id = current_setting('app.school_id')::uuid
    AND user_id <> app.current_user_id()
    AND revoked_at IS NULL;

  GET DIAGNOSTICS revoked_count = ROW_COUNT;

  RETURN revoked_count;
END
$function$;

ALTER FUNCTION app.claim_device_token(text) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.claim_device_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_device_token(text) TO studafy_app;

-- Indexes: school_id leading to satisfy the permissive tenant predicate from the index rather than a
-- recheck, user_id immediately after it for the restrictive one. Every GUC comparison casts to uuid,
-- matching the column type exactly, so none of these is disqualified by an implicit coercion.

-- The inbox's hot path: a user's unread notifications, newest first. Partial because unread is a
-- small and shrinking fraction of a mature inbox -- the index stays proportional to the backlog a
-- user actually has rather than to everything they have ever received, and marking a notification
-- read removes it from the index instead of updating it in place.
CREATE INDEX idx_notifications_school_user_unread
  ON app.notifications (school_id, user_id, created_at DESC)
  WHERE read_at IS NULL;

-- The inbox's second query: full history, newest first, keyset-paginated. id breaks ties between
-- notifications created in the same instant, which a batch write produces by construction.
CREATE INDEX idx_notifications_school_user_created
  ON app.notifications (school_id, user_id, created_at DESC, id);

-- Push targeting: resolve a user's live tokens, optionally narrowed to one platform, most recently
-- seen first. Partial on the same predicate the send path filters by, so revoked routes cost nothing
-- to skip.
CREATE INDEX idx_user_devices_school_user_platform_last_seen
  ON app.user_devices (school_id, user_id, platform, last_seen DESC)
  WHERE revoked_at IS NULL;

-- app.notification_preferences gets no index beyond its primary key. The send-time question -- has
-- this user disabled this type on this channel -- is exactly a lookup on
-- pk_notification_preferences (user_id, notification_type, channel), and its leading column is the
-- selective one: user_id is a globally unique uuid, so the school_id in the tenant predicate is a
-- recheck against a handful of already-located rows (one per type x channel), not a scan.
-- A second, school_id-leading index would duplicate that work for no query. uq_user_devices_user_token
-- likewise already indexes (user_id, fcm_token) for the registration upsert and for
-- app.claim_device_token, so neither is given a redundant partner.

REVOKE ALL PRIVILEGES ON TABLE
  app.notifications, app.notification_preferences, app.user_devices
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.notifications, app.notification_preferences, app.user_devices
TO studafy_app;

REVOKE ALL ON TYPE
  app.notification_type, app.notification_channel, app.device_platform
FROM PUBLIC;
GRANT USAGE ON TYPE
  app.notification_type, app.notification_channel, app.device_platform
TO studafy_app;

-- Tenant isolation: canonical permissive FOR ALL policy on all three tables.

SELECT app.apply_tenant_isolation('app', 'notifications');
SELECT app.apply_tenant_isolation('app', 'notification_preferences');
SELECT app.apply_tenant_isolation('app', 'user_devices');

-- User isolation: RESTRICTIVE policies that AND with tenant_isolation. Scoped to studafy_app so the
-- two SECURITY DEFINER functions above retain their narrow cross-user reach. Requires app.user_id to
-- be set via SET LOCAL alongside app.school_id; an unset or malformed GUC raises rather than matching
-- rows, so the failure mode is closed.
-- Mirrored, with the full rationale, in db/policies/notification_user_isolation.sql.

CREATE POLICY notifications_owner_select ON app.notifications
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (user_id = app.current_user_id());

-- WITH CHECK as well as USING: a recipient may mark their own notification read, but may not hand
-- the row to another user on the way out.
CREATE POLICY notifications_owner_update ON app.notifications
  AS RESTRICTIVE FOR UPDATE TO studafy_app
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

CREATE POLICY notifications_owner_delete ON app.notifications
  AS RESTRICTIVE FOR DELETE TO studafy_app
  USING (user_id = app.current_user_id());

-- No restrictive INSERT policy on app.notifications: senders write rows addressed to other users.
-- tenant_isolation's WITH CHECK still confines every inserted row to the sender's school.

CREATE POLICY notification_preferences_owner ON app.notification_preferences
  AS RESTRICTIVE FOR ALL TO studafy_app
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

CREATE POLICY user_devices_owner ON app.user_devices
  AS RESTRICTIVE FOR ALL TO studafy_app
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

RESET ROLE;
