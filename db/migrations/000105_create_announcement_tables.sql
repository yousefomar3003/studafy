-- Creates app.announcements and app.announcement_recipients (ST-194): admin-composed,
-- audience-targeted school notices with optional scheduled publishing and per-recipient reach
-- tracking.
--
-- app.announcements: one row per composed notice. `mandatory` decides which notification type
-- publishing sends — 'ADMIN_ANNOUNCEMENT' (the platform's one un-optoutable type, see 000082/000083)
-- when true, 'ANNOUNCEMENT' (000104) when false — so the compose form's mandatory toggle is a real
-- choice with a real database-enforced consequence, not cosmetic. `audience_type` plus the two
-- nullable audience columns is a discriminated union enforced by ck_announcements_audience_shape:
-- exactly one of "everyone in the school", "everyone holding one role", or "everyone enrolled in one
-- class" is set per row. `scheduled_at` is always set (immediate sends store the publish instant the
-- admin submitted at) and `status`/`published_at` track whether that instant has been acted on yet —
-- the API publishes synchronously in the same transaction when scheduled_at is due, and the workers'
-- publish-sweep (apps/workers/src/queues/announcements) does the same for the rest once their time
-- comes.
--
-- app.announcement_recipients: the audience snapshot resolved at publish time, one row per intended
-- recipient. `notified_at`/`notification_id` are set together and only for recipients who were
-- actually written an app.notifications row; a row with both NULL means the audience resolver
-- selected that user but their own notification_preferences (mandatory=false only — mandatory
-- announcements cannot be disabled, see 000083) turned the type off. This is what makes "reach"
-- honest: COUNT(*) is the intended audience at publish time (a roster snapshot, immune to later
-- membership changes), COUNT(*) FILTER (WHERE notified_at IS NOT NULL) is who was actually notified,
-- and the difference is exactly the recipients who opted out — the same distinction
-- docs/database/notifications-data-model.md draws between "addressed" and "delivered".
--
-- Depends on 000004 (app.schools), 000006 (app.apply_tenant_isolation), 000007 (app.users,
-- app.user_role), 000009 (app.classes), 000017 (app.notifications), 000104 (the ANNOUNCEMENT
-- notification type).

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.announcements (
  id              uuid        DEFAULT gen_random_uuid() CONSTRAINT pk_announcements PRIMARY KEY,
  school_id       uuid        NOT NULL,
  created_by      uuid        NOT NULL,
  title           text        NOT NULL,
  body            text        NOT NULL,
  mandatory       boolean     NOT NULL DEFAULT false,
  audience_type   text        NOT NULL CHECK (audience_type IN ('school', 'role', 'class')),
  audience_role   app.user_role,
  audience_class_id uuid,
  status          text        NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'published')),
  scheduled_at    timestamptz NOT NULL,
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_announcements_id_school UNIQUE (id, school_id),

  CONSTRAINT fk_announcements_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_announcements_created_by
    FOREIGN KEY (created_by, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_announcements_class
    FOREIGN KEY (audience_class_id, school_id) REFERENCES app.classes (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_announcements_title CHECK (
    title = btrim(title) AND title <> '' AND char_length(title) <= 200
  ),
  CONSTRAINT ck_announcements_body CHECK (
    body = btrim(body) AND body <> '' AND char_length(body) <= 5000
  ),
  -- Exactly one audience shape: school-wide names neither a role nor a class, role-targeted names a
  -- role and no class, class-targeted names a class and no role.
  CONSTRAINT ck_announcements_audience_shape CHECK (
    (audience_type = 'school' AND audience_role IS NULL AND audience_class_id IS NULL)
    OR (audience_type = 'role' AND audience_role IS NOT NULL AND audience_class_id IS NULL)
    OR (audience_type = 'class' AND audience_role IS NULL AND audience_class_id IS NOT NULL)
  ),
  CONSTRAINT ck_announcements_publish_state CHECK (
    (status = 'published' AND published_at IS NOT NULL)
    OR (status = 'scheduled' AND published_at IS NULL)
  ),
  CONSTRAINT ck_announcements_timestamps CHECK (updated_at >= created_at)
);

-- Powers the scheduled-publish sweep's exact predicate (status = 'scheduled' AND scheduled_at <= now()).
-- Partial or the index would carry every published row forever for a predicate that only ever
-- matches the scheduled ones — the same reasoning as idx_notifications_school_user_unread.
CREATE INDEX idx_announcements_school_scheduled_due
  ON app.announcements (school_id, scheduled_at)
  WHERE status = 'scheduled';

-- Powers the admin history list: newest first, keyset-paginated, same shape as
-- idx_notifications_school_user_created.
CREATE INDEX idx_announcements_school_created
  ON app.announcements (school_id, created_at DESC, id DESC);

CREATE TABLE app.announcement_recipients (
  id              uuid        DEFAULT gen_random_uuid() CONSTRAINT pk_announcement_recipients PRIMARY KEY,
  school_id       uuid        NOT NULL,
  announcement_id uuid        NOT NULL,
  user_id         uuid        NOT NULL,
  notified_at     timestamptz,
  notification_id uuid,
  created_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_announcement_recipients_id_school UNIQUE (id, school_id),
  -- One resolution per recipient per announcement; the publish path is a single set-based INSERT and
  -- this is what makes a replayed publish (the scheduled sweep re-selecting a row it already
  -- processed) fail loudly on ON CONFLICT rather than double-notify.
  CONSTRAINT uq_announcement_recipients_announcement_user UNIQUE (school_id, announcement_id, user_id),

  CONSTRAINT fk_announcement_recipients_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_announcement_recipients_announcement
    FOREIGN KEY (announcement_id, school_id) REFERENCES app.announcements (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_announcement_recipients_user
    FOREIGN KEY (user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_announcement_recipients_notification
    FOREIGN KEY (notification_id, school_id) REFERENCES app.notifications (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_announcement_recipients_notified_pair CHECK (
    (notified_at IS NULL AND notification_id IS NULL)
    OR (notified_at IS NOT NULL AND notification_id IS NOT NULL)
  )
);

-- No separate (school_id, announcement_id) index: uq_announcement_recipients_announcement_user's
-- underlying btree already leads with both columns, which is what the reach-stats aggregate
-- (COUNT(*), COUNT(*) FILTER (WHERE notified_at IS NOT NULL) grouped by announcement_id) scans.

-- ---------------------------------------------------------------------------------------------------
-- 2. Security-definer helper
-- ---------------------------------------------------------------------------------------------------

-- Publishing a non-mandatory announcement needs to know which of its resolved recipients have
-- disabled 'ANNOUNCEMENT' on the in_app channel -- and those rows belong to other users, which
-- notification_preferences_owner (000017) makes invisible to studafy_app under RLS. SECURITY
-- DEFINER for the same reason app.claim_device_token exists: the rows it must read belong to other
-- users. Its own reach is bounded three ways, mirroring that function -- it only ever reads (never
-- writes), it is confined to current_setting('app.school_id') so it cannot cross a tenant boundary,
-- and it is hardcoded to the one notification_type/channel pair the announcements feature checks, so
-- granting EXECUTE cannot be repurposed into a general preferences-reading capability.
CREATE FUNCTION app.get_announcement_opted_out_users(candidate_ids uuid[])
RETURNS TABLE (user_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT np.user_id
  FROM app.notification_preferences AS np
  WHERE np.school_id = current_setting('app.school_id')::uuid
    AND np.notification_type = 'ANNOUNCEMENT'::app.notification_type
    AND np.channel = 'in_app'
    AND np.enabled = false
    AND np.user_id = ANY (candidate_ids)
$function$;

ALTER FUNCTION app.get_announcement_opted_out_users(uuid[]) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.get_announcement_opted_out_users(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.get_announcement_opted_out_users(uuid[]) TO studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 3. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE
  app.announcements, app.announcement_recipients
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.announcements, app.announcement_recipients
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'announcements');
SELECT app.apply_tenant_isolation('app', 'announcement_recipients');

RESET ROLE;
