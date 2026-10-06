-- Add the school's teaching week to school_settings: which weekdays it teaches and how many periods
-- a day has. The timetable grid renders exactly these columns and rows instead of a fixed
-- Monday-to-Sunday, eight-period frame.
--
-- school_days uses the same 1=Mon..7=Sun numbering as app.timetable_slots.weekday. The default,
-- Sunday to Thursday, is the Gulf school week this product launches with; schools change it from the
-- timetable page (PUT /api/academics/timetable-settings, timetable:manage).
--
-- Existing slots on a day later removed from school_days are kept, not deleted: the setting shapes
-- what the grid shows, and the grid still surfaces any day that has lessons.

SET ROLE studafy_admin;

ALTER TABLE app.school_settings
  ADD COLUMN school_days smallint[] NOT NULL DEFAULT '{7,1,2,3,4}',
  ADD COLUMN periods_per_day smallint NOT NULL DEFAULT 8,
  ADD CONSTRAINT ck_school_settings_school_days CHECK (
    cardinality(school_days) BETWEEN 1 AND 7
    AND school_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]
  ),
  ADD CONSTRAINT ck_school_settings_periods_per_day CHECK (periods_per_day BETWEEN 1 AND 16);

COMMENT ON COLUMN app.school_settings.school_days IS
  'Teaching weekdays shown on the timetable, 1=Mon..7=Sun, in display order.';
COMMENT ON COLUMN app.school_settings.periods_per_day IS
  'Number of timetable periods per teaching day.';

RESET ROLE;
