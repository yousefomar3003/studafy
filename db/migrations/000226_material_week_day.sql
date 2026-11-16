-- Which week of the term, and which day of that week, a class material belongs to.
--
-- The app groups a class's materials into collapsible week sections with day sub-groups, and the
-- teacher picks the week and day when uploading. The placement is stored as explicit numbers
-- rather than a date on purpose: week 1 is the week that contains the class's term start
-- (app.terms.starts_on, through app.classes.term_id), and an admin who corrects the term dates
-- must not silently move every material to a different week or day.
--
--   week_number  1..60, the week of the term (60 covers a full-year term with room to spare)
--   day_of_week  1..7, ISO weekday (1 = Monday .. 7 = Sunday), the numbering timetable slots and
--                app.school_settings.school_days already use
--
-- Both are NULL for every material uploaded before this migration and for any upload from an
-- older app version that does not send them; the app lists those under "Unscheduled". The two
-- columns are set together or cleared together (ck_materials_week_day_pair), so a material is
-- never placed in a week without a day or on a day without a week.
--
-- No index: the list filter is always narrowed by class first (idx_materials_school_class_created_at),
-- and a class holds few enough materials that a week filter on top of it is cheap without one.

SET ROLE studafy_admin;

ALTER TABLE app.materials
  ADD COLUMN week_number smallint,
  ADD COLUMN day_of_week smallint;

ALTER TABLE app.materials
  ADD CONSTRAINT ck_materials_week_number CHECK (week_number BETWEEN 1 AND 60),
  ADD CONSTRAINT ck_materials_day_of_week CHECK (day_of_week BETWEEN 1 AND 7),
  ADD CONSTRAINT ck_materials_week_day_pair CHECK ((week_number IS NULL) = (day_of_week IS NULL));

COMMENT ON COLUMN app.materials.week_number IS
  'Week of the class''s term this material belongs to, 1 = the week containing the term start; '
  'NULL = unscheduled (000226).';

COMMENT ON COLUMN app.materials.day_of_week IS
  'ISO weekday (1 = Mon .. 7 = Sun) within week_number; set together with week_number (000226).';

RESET ROLE;
