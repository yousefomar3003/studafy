-- Platform announcements: the banner a Studafy super admin shows every user, or every school's
-- staff, for a window of time -- "Maintenance on Saturday 02:00-03:00 UTC", "New report cards are
-- live". Written in the platform console (/api/platform/announcements), read by every signed-in
-- client (/api/platform-banners).
--
-- GLOBAL BY CONSTRUCTION. An announcement belongs to Studafy, not to any school: one row is shown in
-- every school, so there is no school_id to isolate by. Like sales_inquiries (000125) it is reachable
-- by studafy_admin only; the API reads and writes it inside withSystemTx, and studafy_app has no
-- privileges at all. It is listed in db/policies/rls-coverage.ts's approved globals.
--
-- WHO WROTE IT. created_by / updated_by are the operator's user id in their home (platform) school.
-- They are not foreign keys: app.users is keyed by (id, school_id) and this table has no school_id,
-- so the composite FK every tenant table uses cannot apply. Accountability lives in the operator's
-- home-school audit row (written by the API with the change's reason), not in these columns.
--
-- DISMISSAL is a per-device convenience kept in the browser, not state: a dismissed banner coming
-- back on another device is harmless, and keeping it out of the database keeps this table write-only
-- for Studafy staff. A maintenance banner cannot be dismissed at all.
--
-- ENDING EARLY sets ends_at to now; rows are never deleted, so the console keeps the history.

SET ROLE studafy_admin;

CREATE TABLE app.platform_announcements (
  id          uuid        DEFAULT gen_random_uuid() CONSTRAINT pk_platform_announcements PRIMARY KEY,
  message_en  text        NOT NULL,
  message_ar  text,
  audience    text        NOT NULL DEFAULT 'all',
  severity    text        NOT NULL DEFAULT 'info',
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  created_by  uuid        NOT NULL,
  updated_by  uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT ck_platform_announcements_message_en CHECK (
    message_en = btrim(message_en) AND message_en <> '' AND char_length(message_en) <= 500
  ),
  CONSTRAINT ck_platform_announcements_message_ar CHECK (
    message_ar IS NULL
    OR (message_ar = btrim(message_ar) AND message_ar <> '' AND char_length(message_ar) <= 500)
  ),
  -- 'all': every signed-in user. 'staff': users holding a school staff role (ORG_ADMIN, PRINCIPAL,
  -- ATTENDANCE_OFFICER, FINANCE, INSTRUCTOR) -- packages/constants SCHOOL_STAFF_ROLES.
  CONSTRAINT ck_platform_announcements_audience CHECK (audience IN ('all', 'staff')),
  CONSTRAINT ck_platform_announcements_severity CHECK (severity IN ('info', 'warning', 'maintenance')),
  CONSTRAINT ck_platform_announcements_window CHECK (ends_at > starts_at),
  CONSTRAINT ck_platform_announcements_timestamps CHECK (updated_at >= created_at)
);

-- The active-banner read: WHERE starts_at <= now() AND ends_at > now(). ends_at leads because past
-- rows (the bulk, kept forever) are excluded by it; the few current and future rows are then
-- filtered on starts_at.
CREATE INDEX idx_platform_announcements_ends_starts
  ON app.platform_announcements (ends_at, starts_at);

-- The console's history list, newest first.
CREATE INDEX idx_platform_announcements_created ON app.platform_announcements (created_at DESC);

REVOKE ALL PRIVILEGES ON TABLE app.platform_announcements FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE app.platform_announcements FROM studafy_app;

ALTER TABLE app.platform_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.platform_announcements FORCE ROW LEVEL SECURITY;

CREATE POLICY global_admin_only ON app.platform_announcements
  AS PERMISSIVE FOR ALL TO studafy_admin USING (true) WITH CHECK (true);

COMMENT ON TABLE app.platform_announcements IS
  'Studafy-wide banners (000214): message, audience, severity and time window. Global, studafy_admin only.';

RESET ROLE;
