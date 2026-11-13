-- Rooms are no longer part of building a timetable: a lesson is a class (taught to a grade
-- section, 000147), a teacher, a weekday and a period. app.classes.room_id and
-- app.timetable_slots.room_id become optional; new classes and lessons are created without one.
--
-- Existing values are kept, not cleared: approved and archived timetable versions are immutable
-- (enforce_timetable_slot_version_editable), and exams still check their own optional room against
-- any lesson that has one. The composite foreign keys are MATCH SIMPLE, so a NULL room is
-- unchecked, and ex_timetable_slots_room_weekday_period never fires for NULLs (NULL = NULL is not
-- true), so lessons without a room never clash on room.

SET ROLE studafy_admin;

ALTER TABLE app.classes ALTER COLUMN room_id DROP NOT NULL;
ALTER TABLE app.timetable_slots ALTER COLUMN room_id DROP NOT NULL;

COMMENT ON COLUMN app.classes.room_id IS
  'Optional since 000148: timetables are built per grade section, without rooms.';
COMMENT ON COLUMN app.timetable_slots.room_id IS
  'Optional since 000148: timetables are built per grade section, without rooms.';

RESET ROLE;
