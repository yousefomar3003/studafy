-- studafy:migration transaction=off
-- Timetable slots by teacher, for the two ways RLS asks "does this teacher teach the class?":
--
--   app.teaches_class (000037) probes (school_id, class_id, teacher_id) once per candidate row inside
--   the role_scope_visibility policies still built on it (enrollments, gradebooks, submissions, ...).
--   app.readable_class_ids (000176) lists a teacher's classes by (school_id, teacher_id) once per
--   statement.
--
-- idx_timetable_slots_school_class_id (000010) covers (school_id, class_id) only, leaving teacher_id
-- to a heap filter over every slot of the class, and the EXCLUDE constraints' indexes lead with
-- timetable_version_id, which neither lookup constrains. Leading with teacher_id serves both: the
-- probe pins all three columns, the listing the first two. Built concurrently so timetable editing
-- stays writable while it builds.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_timetable_slots_school_teacher_class
  ON app.timetable_slots (school_id, teacher_id, class_id);
