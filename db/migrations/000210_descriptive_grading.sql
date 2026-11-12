-- Descriptive grading (kindergarten and early primary): subjects graded without numbers.
--
-- A subject config with grading_method 'descriptive' has skills instead of marked assessments: its
-- categories group the skills ("Reading") and its assessments are the skills ("Reads fluently"),
-- each in a term. A teacher records one descriptor per skill and student, chosen from the grade's
-- descriptor scale ("Excellent", "Very good", "Good", "Needs improvement").
--
--   app.grade_program_descriptors  one grade's scale for one academic year, highest first
--                                  (position 1). Points are optional; when every descriptor has
--                                  them the subject's own descriptor is worked out from the average.
--                                  `not_achieved` marks descriptors a subject cannot pass with.
--   app.student_marks.descriptor_id  the chosen descriptor of a graded mark in a descriptive
--                                  subject. A graded mark has a score or a descriptor, never both.
--                                  RESTRICT: a descriptor that marks use cannot be deleted.
--   app.subject_configs            'descriptive' joins the methods; such a subject never counts in
--                                  the numeric average.
--   app.student_subject_results.is_descriptive  a complete descriptive result carries a pass/fail
--                                  decision but no percentage or marks; existing rows are numeric.
--
-- Additive only: existing configs, marks, finalized results and certificates are unchanged.

SET ROLE studafy_admin;

-- Validating the changed CHECKs scans tables whose forced RLS applies the tenant_isolation
-- predicate even to the owner (see 000114, 000198, 000203). Every existing row satisfies the new
-- checks by construction (no config is descriptive yet, the new columns are NULL / false), so the
-- nil tenant's empty scan is exact.
SELECT pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

CREATE TABLE app.grade_program_descriptors (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_grade_program_descriptors PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  grade_level_id uuid NOT NULL,
  position smallint NOT NULL,
  label text NOT NULL,
  points numeric(6, 2),
  not_achieved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_grade_program_descriptors_id_school UNIQUE (id, school_id),
  -- Deferred so a reorder can move rows through each other's positions inside one transaction.
  CONSTRAINT uq_grade_program_descriptors_position
    UNIQUE (school_id, academic_year_id, grade_level_id, position) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_grade_program_descriptors_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_grade_program_descriptors_program
    FOREIGN KEY (academic_year_id, grade_level_id, school_id)
    REFERENCES app.grade_programs (academic_year_id, grade_level_id, school_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_grade_program_descriptors_position CHECK (position BETWEEN 1 AND 20),
  CONSTRAINT ck_grade_program_descriptors_label
    CHECK (label = btrim(label) AND label <> '' AND char_length(label) <= 60),
  CONSTRAINT ck_grade_program_descriptors_points CHECK (points IS NULL OR points >= 0),
  CONSTRAINT ck_grade_program_descriptors_timestamps CHECK (updated_at >= created_at)
);
CREATE INDEX idx_grade_program_descriptors_program_fk
  ON app.grade_program_descriptors (academic_year_id, grade_level_id, school_id);

COMMENT ON TABLE app.grade_program_descriptors IS
  'Descriptor scale of one grade in one academic year (descriptive subjects), highest first.';

ALTER TABLE app.subject_configs
  DROP CONSTRAINT ck_subject_configs_method,
  ADD CONSTRAINT ck_subject_configs_method
    CHECK (grading_method IN ('weighted', 'total_points', 'descriptive')),
  ADD CONSTRAINT ck_subject_configs_descriptive_average
    CHECK (grading_method <> 'descriptive' OR include_in_average = false);

ALTER TABLE app.student_marks
  ADD COLUMN descriptor_id uuid,
  ADD CONSTRAINT fk_student_marks_descriptor FOREIGN KEY (descriptor_id, school_id)
    REFERENCES app.grade_program_descriptors (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  DROP CONSTRAINT ck_student_marks_score,
  ADD CONSTRAINT ck_student_marks_score CHECK (
    (status = 'graded') = (score IS NOT NULL OR descriptor_id IS NOT NULL)
    AND NOT (score IS NOT NULL AND descriptor_id IS NOT NULL)
    AND (score IS NULL OR score >= 0)
  );
CREATE INDEX idx_student_marks_descriptor_fk
  ON app.student_marks (descriptor_id, school_id) WHERE descriptor_id IS NOT NULL;

ALTER TABLE app.student_subject_results
  ADD COLUMN is_descriptive boolean NOT NULL DEFAULT false,
  DROP CONSTRAINT ck_student_subject_results_complete,
  ADD CONSTRAINT ck_student_subject_results_complete CHECK (
    (status = 'complete') = (
      passed IS NOT NULL
      AND (is_descriptive OR (percentage IS NOT NULL AND marks_obtained IS NOT NULL))
    )
  ),
  ADD CONSTRAINT ck_student_subject_results_descriptive CHECK (
    NOT is_descriptive
    OR (percentage IS NULL AND marks_obtained IS NULL AND gpa_points IS NULL
        AND include_in_average = false)
  );

REVOKE ALL PRIVILEGES ON TABLE app.grade_program_descriptors FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.grade_program_descriptors TO studafy_app;
-- Configuration, not personal data: tenant isolation only, like the grade scales.
SELECT app.apply_tenant_isolation('app', 'grade_program_descriptors');

RESET ROLE;
