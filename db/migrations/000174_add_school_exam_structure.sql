-- The school's exam system, chosen once in School Settings and used to set up every subject.
--
-- Two systems are in use:
--   midterm  each term: midterm exam, final exam, quizzes, homework
--   periods  each term: first period exam, second period exam, final exam, quizzes, homework
-- exam_weights holds the admin's share for each part of a term (keys are category kinds, values sum
-- to 100; a part at 0 is left out). The API validates the keys against exam_structure; the column
-- only guarantees an object. The grading module builds a subject's term categories and assessments
-- from these (apps/api/src/modules/grading/exam-structure.ts): new subjects start from it, and
-- "apply to all subjects" rebuilds the active year's subjects that have no marks yet.
--
-- 'first_period' and 'second_period' join the category kinds so the two period exams are told
-- apart from a generic 'exam' everywhere a category is shown.

SET ROLE studafy_admin;

ALTER TABLE app.school_settings
  ADD COLUMN exam_structure text NOT NULL DEFAULT 'midterm',
  ADD COLUMN exam_weights jsonb NOT NULL
    DEFAULT '{"midterm": 30, "final_exam": 40, "quiz": 15, "homework": 15}'::jsonb,
  ADD CONSTRAINT ck_school_settings_exam_structure CHECK (exam_structure IN ('midterm', 'periods')),
  ADD CONSTRAINT ck_school_settings_exam_weights CHECK (jsonb_typeof(exam_weights) = 'object');

COMMENT ON COLUMN app.school_settings.exam_structure IS
  'Exam system used to set up subjects: midterm (midterm + final) or periods (first + second period + final).';
COMMENT ON COLUMN app.school_settings.exam_weights IS
  'Share of a term per part, keyed by category kind; values sum to 100.';

ALTER TABLE app.subject_config_categories
  DROP CONSTRAINT ck_subject_config_categories_kind,
  ADD CONSTRAINT ck_subject_config_categories_kind CHECK (kind IN (
    'homework', 'quiz', 'classwork', 'project', 'practical', 'participation', 'exam',
    'first_period', 'second_period', 'midterm', 'final_exam', 'other'
  ));

RESET ROLE;
