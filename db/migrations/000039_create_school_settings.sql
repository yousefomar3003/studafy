-- Per-school configuration settings.
--
-- Provides GET/PATCH /api/schools/current/settings:
-- 1. A dedicated settings table scoped to each school tenant.
-- 2. Covers profile preferences (locale, timezone), academic policy (grading scheme),
--    invitation lifecycle (expiry days), and attendance alert thresholds.
-- 3. studafy_app gains SELECT/INSERT/UPDATE; DELETE is never permitted (settings rows
--    are immortal once created).

SET ROLE studafy_admin;

CREATE TABLE app.school_settings (
  school_id uuid NOT NULL CONSTRAINT pk_school_settings PRIMARY KEY
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  locale text NOT NULL DEFAULT 'en',
  timezone text NOT NULL DEFAULT 'Africa/Casablanca',
  grading_scheme text NOT NULL DEFAULT 'letter',
  invitation_expiry_days integer NOT NULL DEFAULT 7,
  attendance_alert_threshold numeric(5,2) NOT NULL DEFAULT 75.00,
  absence_alert_threshold numeric(5,2) NOT NULL DEFAULT 50.00,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_school_settings_locale CHECK (
    locale ~ '^[a-z]{2}(-[A-Z]{2})?$' AND char_length(locale) BETWEEN 2 AND 5
  ),
  CONSTRAINT ck_school_settings_timezone CHECK (
    timezone ~ '^[A-Za-z]+/[A-Za-z_]+$' AND char_length(timezone) <= 50
  ),
  CONSTRAINT ck_school_settings_grading_scheme CHECK (
    grading_scheme IN ('letter', 'percentage', 'gpa', 'numeric', 'pass_fail')
  ),
  CONSTRAINT ck_school_settings_invitation_expiry_days CHECK (
    invitation_expiry_days BETWEEN 1 AND 365
  ),
  CONSTRAINT ck_school_settings_attendance_alert_threshold CHECK (
    attendance_alert_threshold BETWEEN 0.00 AND 100.00
  ),
  CONSTRAINT ck_school_settings_absence_alert_threshold CHECK (
    absence_alert_threshold BETWEEN 0.00 AND 100.00
  ),
  CONSTRAINT ck_school_settings_timestamps CHECK (updated_at >= created_at)
);

GRANT SELECT, INSERT, UPDATE ON TABLE app.school_settings TO studafy_app;
REVOKE INSERT, UPDATE ON TABLE app.school_settings FROM PUBLIC;

RESET ROLE;
