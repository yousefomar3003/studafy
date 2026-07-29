-- Add attendance_correction_window_hours to school_settings (ST-109).
--
-- How long after a session's business date an attendance record stays correctable by the
-- teacher who owns the class. Measured from midnight of attendance_sessions.session_date in the
-- school's own timezone (school_settings.timezone), so the deadline is the same wall-clock
-- moment for every record of that session.
--
-- Past the window a teacher is refused (403 ATTENDANCE_CORRECTION_WINDOW_EXPIRED) and only a
-- principal may proceed, with the correction flagged as an administrative override. Defaults to
-- 48 hours for existing schools; the API applies the same default when a school has no settings
-- row yet, since the row is created lazily on first read.

SET ROLE studafy_admin;

ALTER TABLE app.school_settings
  ADD COLUMN attendance_correction_window_hours integer NOT NULL DEFAULT 48;

ALTER TABLE app.school_settings
  ADD CONSTRAINT ck_school_settings_attendance_correction_window
    CHECK (attendance_correction_window_hours BETWEEN 1 AND 8760);

COMMENT ON COLUMN app.school_settings.attendance_correction_window_hours IS
  'Hours after a session''s business date during which a teacher may still correct its '
  'attendance records. Beyond it, only a principal may correct, as an out-of-window override.';

RESET ROLE;
