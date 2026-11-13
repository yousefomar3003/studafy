-- Grading: a third exam system and a per-grade choice of how the final result is shown.
--
-- 1. THREE PERIOD EXAMS. School Settings gains `three_periods`: each term has a first, second and
--    third period exam and a final exam, with quizzes and homework (apps/api/src/modules/grading/
--    exam-structure.ts). `third_period` joins the category kinds so the third exam is told apart
--    from the other two everywhere a category is shown.
--
-- 2. RESULT FORMAT. Schools show the year's final result differently: as a percentage, out of 20 (or
--    10, or any maximum) or as a GPA out of 4 or 5. Each grade program (one grade in one year) says
--    which, in result_format + result_scale_max:
--
--      percentage  the average out of 100; result_scale_max is NULL. The default, so every existing
--                  grade keeps showing exactly what it showed before.
--      out_of      the average rescaled to result_scale_max (82.5% -> 16.5 out of 20).
--      gpa         the subjects' grade-band GPA points, weighted by the subject coefficients, on a
--                  result_scale_max-point scale (4 or 5).
--
--    A finalized overall result records the format, maximum and value it was computed with
--    (result_format, result_scale_max, result_value), so changing a grade's format later never
--    changes a finalized result or an issued certificate. Rows finalized before this migration keep
--    NULL there and mean "percentage", which is what they showed.

SET ROLE studafy_admin;

ALTER TABLE app.school_settings
  DROP CONSTRAINT ck_school_settings_exam_structure,
  ADD CONSTRAINT ck_school_settings_exam_structure
    CHECK (exam_structure IN ('midterm', 'periods', 'three_periods'));

COMMENT ON COLUMN app.school_settings.exam_structure IS
  'Exam system used to set up subjects: midterm (midterm + final), periods (first + second period + final) or three_periods (first + second + third period + final).';

ALTER TABLE app.subject_config_categories
  DROP CONSTRAINT ck_subject_config_categories_kind,
  ADD CONSTRAINT ck_subject_config_categories_kind CHECK (kind IN (
    'homework', 'quiz', 'classwork', 'project', 'practical', 'participation', 'exam',
    'first_period', 'second_period', 'third_period', 'midterm', 'final_exam', 'other'
  ));

ALTER TABLE app.grade_programs
  ADD COLUMN result_format text NOT NULL DEFAULT 'percentage',
  ADD COLUMN result_scale_max numeric(6, 2),
  ADD CONSTRAINT ck_grade_programs_result_format
    CHECK (result_format IN ('percentage', 'out_of', 'gpa')),
  ADD CONSTRAINT ck_grade_programs_result_scale_max CHECK (
    (result_format = 'percentage' AND result_scale_max IS NULL)
    OR (result_format = 'out_of' AND result_scale_max > 0 AND result_scale_max <= 1000)
    OR (result_format = 'gpa' AND result_scale_max > 0 AND result_scale_max <= 10)
  );

COMMENT ON COLUMN app.grade_programs.result_format IS
  'How the final result is shown: percentage (out of 100), out_of (rescaled to result_scale_max) or gpa (weighted GPA points out of result_scale_max).';
COMMENT ON COLUMN app.grade_programs.result_scale_max IS
  'The maximum for out_of (e.g. 20) or gpa (4 or 5); NULL for percentage.';

ALTER TABLE app.student_overall_results
  ADD COLUMN result_format text,
  ADD COLUMN result_scale_max numeric(6, 2),
  ADD COLUMN result_value numeric(9, 3),
  ADD CONSTRAINT ck_student_overall_results_result_format
    CHECK (result_format IS NULL OR result_format IN ('percentage', 'out_of', 'gpa')),
  -- No upper bound: a scale may give a band more GPA points than the grade's maximum (an A+ worth
  -- 4.3 on a 4-point GPA). The publish check warns about that; finalizing must not fail on it.
  ADD CONSTRAINT ck_student_overall_results_result_value CHECK (
    result_value IS NULL OR (result_scale_max IS NOT NULL AND result_value >= 0)
  );

COMMENT ON COLUMN app.student_overall_results.result_format IS
  'The grade''s result format when finalized; NULL on rows finalized before formats existed (percentage).';
COMMENT ON COLUMN app.student_overall_results.result_scale_max IS
  'The format''s maximum when finalized: 100 for percentage, the chosen maximum otherwise.';
COMMENT ON COLUMN app.student_overall_results.result_value IS
  'The final result in result_format; NULL when incomplete, or a GPA with a subject lacking GPA points.';

RESET ROLE;
