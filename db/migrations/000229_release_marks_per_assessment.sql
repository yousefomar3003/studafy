-- Release one assessment's marks at a time.
--
-- Until now a mark reached the student and their parents only once leadership approved the whole
-- period's mark sheet (000173: section x subject x term), and a teacher could only submit that sheet
-- once every enrolled student had a mark for every assessment of the term. So the first exam's marks
-- waited for the second, the third, the final and the homework. A teacher can now send one
-- assessment's marks for the same leadership approval as soon as that assessment is complete for
-- the class; once approved, those marks are released exactly like an approved sheet's.
--
--   app.assessment_mark_releases  one row per (section, assessment) that has been sent for approval.
--                                 No row means "draft". Lifecycle mirrors app.mark_sheets:
--                                   submitted  waiting for leadership (the marks are locked)
--                                   approved   released to the student and their parents (locked)
--                                   returned   sent back, or withdrawn after approval, with a reason
--                                 A teacher changing a mark of a returned assessment deletes the row
--                                 (back to draft), as editing a returned sheet puts it back to draft.
--                                 subject_id and term_id are the assessment's, kept on the row so it
--                                 lines up with its period's mark sheet without a join.
--
-- The whole-period sheet is unchanged: it still needs every mark before it can be submitted, term
-- results still need approved sheets to be finalized, and nothing here computes or shows a term
-- result. app.is_released_student_mark gains one arm: a mark is released when its period's sheet is
-- approved OR its own assessment's release (for the student's section) is approved.
-- app.can_read_subject gains the matching arm, so a subject released one assessment at a time comes
-- back with its name for the student and their parents.
--
-- CREATE OR REPLACE keeps both helpers' owner and grants from 000160/000173.

SELECT pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
SET ROLE studafy_admin;

CREATE TABLE app.assessment_mark_releases (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_assessment_mark_releases PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  section_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  term_id uuid,
  assessment_id uuid NOT NULL,
  status text NOT NULL,
  submitted_by_user_id uuid NOT NULL,
  submitted_at timestamptz NOT NULL,
  decided_by_user_id uuid,
  decided_at timestamptz,
  return_reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_assessment_mark_releases_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_assessment_mark_releases_section_assessment
    UNIQUE (school_id, section_id, assessment_id),
  CONSTRAINT fk_assessment_mark_releases_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_assessment_mark_releases_section FOREIGN KEY (section_id, academic_year_id, school_id)
    REFERENCES app.sections (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_assessment_mark_releases_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_assessment_mark_releases_term FOREIGN KEY (term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_assessment_mark_releases_assessment
    FOREIGN KEY (assessment_id, academic_year_id, school_id)
    REFERENCES app.subject_config_assessments (id, academic_year_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_assessment_mark_releases_submitted_by FOREIGN KEY (submitted_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_assessment_mark_releases_decided_by FOREIGN KEY (decided_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_assessment_mark_releases_status
    CHECK (status IN ('submitted', 'approved', 'returned')),
  CONSTRAINT ck_assessment_mark_releases_lifecycle CHECK (
    (status = 'submitted' AND decided_at IS NULL AND decided_by_user_id IS NULL
      AND return_reason IS NULL)
    OR (status = 'approved' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
      AND return_reason IS NULL)
    OR (status = 'returned' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
      AND return_reason IS NOT NULL AND btrim(return_reason) <> ''
      AND char_length(return_reason) <= 2000)
  ),
  CONSTRAINT ck_assessment_mark_releases_timestamps CHECK (updated_at >= created_at)
);
CREATE INDEX idx_assessment_mark_releases_school_status
  ON app.assessment_mark_releases (school_id, academic_year_id, status, submitted_at);
CREATE INDEX idx_assessment_mark_releases_section_fk
  ON app.assessment_mark_releases (section_id, academic_year_id, school_id);
CREATE INDEX idx_assessment_mark_releases_subject_fk
  ON app.assessment_mark_releases (subject_id, school_id);
CREATE INDEX idx_assessment_mark_releases_term_fk
  ON app.assessment_mark_releases (term_id, academic_year_id, school_id) WHERE term_id IS NOT NULL;
CREATE INDEX idx_assessment_mark_releases_assessment_fk
  ON app.assessment_mark_releases (assessment_id, academic_year_id, school_id);
CREATE INDEX idx_assessment_mark_releases_submitted_by_fk
  ON app.assessment_mark_releases (submitted_by_user_id, school_id);
CREATE INDEX idx_assessment_mark_releases_decided_by_fk
  ON app.assessment_mark_releases (decided_by_user_id, school_id)
  WHERE decided_by_user_id IS NOT NULL;

COMMENT ON TABLE app.assessment_mark_releases IS
  'One assessment''s marks for one section sent for leadership approval; approved = released to '
  'the student and their parents before the whole period''s mark sheet is approved (000229).';

-- Like app.mark_sheets: workflow state, not personal data; tenant isolation only.
REVOKE ALL PRIVILEGES ON TABLE app.assessment_mark_releases FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.assessment_mark_releases TO studafy_app;
SELECT app.apply_tenant_isolation('app', 'assessment_mark_releases');

-- The student, or a parent linked to them: the mark's period sheet is approved for the student's
-- section, or the mark's own assessment has an approved release for that section.
CREATE OR REPLACE FUNCTION app.is_released_student_mark(
  target_student_id uuid,
  target_assessment_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.is_related_to_student(target_student_id)
    AND EXISTS (
      SELECT 1
      FROM app.subject_config_assessments AS assessment
      JOIN app.subject_configs AS config
        ON config.id = assessment.subject_config_id AND config.school_id = assessment.school_id
      JOIN app.student_sections AS placement
        ON placement.student_id = target_student_id
       AND placement.academic_year_id = assessment.academic_year_id
       AND placement.school_id = assessment.school_id
      WHERE assessment.id = target_assessment_id
        AND assessment.school_id = current_setting('app.school_id')::uuid
        AND assessment.status = 'active'
        AND (
          EXISTS (
            SELECT 1
            FROM app.mark_sheets AS sheet
            WHERE sheet.school_id = assessment.school_id
              AND sheet.academic_year_id = assessment.academic_year_id
              AND sheet.section_id = placement.section_id
              AND sheet.subject_id = config.subject_id
              AND sheet.term_id IS NOT DISTINCT FROM assessment.term_id
              AND sheet.status = 'approved'
          )
          OR EXISTS (
            SELECT 1
            FROM app.assessment_mark_releases AS mark_release
            WHERE mark_release.school_id = assessment.school_id
              AND mark_release.section_id = placement.section_id
              AND mark_release.assessment_id = assessment.id
              AND mark_release.status = 'approved'
          )
        )
    )
$function$;

CREATE OR REPLACE FUNCTION app.can_read_subject(target_subject_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.current_user_is_school_admin()
    OR EXISTS (
      SELECT 1
      FROM app.courses AS co
      JOIN app.classes AS c ON c.course_id = co.id AND c.school_id = co.school_id
      WHERE co.subject_id = target_subject_id
        AND co.school_id = current_setting('app.school_id')::uuid
        AND app.can_read_class(c.id)
    )
    OR EXISTS (
      SELECT 1
      FROM app.section_subject_teachers AS assignment
      WHERE assignment.subject_id = target_subject_id
        AND assignment.school_id = current_setting('app.school_id')::uuid
        AND assignment.teacher_id = app.current_user_teacher_id()
    )
    OR EXISTS (
      SELECT 1
      FROM app.mark_sheets AS sheet
      JOIN app.student_sections AS placement
        ON placement.section_id = sheet.section_id
       AND placement.academic_year_id = sheet.academic_year_id
       AND placement.school_id = sheet.school_id
      WHERE sheet.subject_id = target_subject_id
        AND sheet.school_id = current_setting('app.school_id')::uuid
        AND sheet.status = 'approved'
        AND app.is_related_to_student(placement.student_id)
    )
    OR EXISTS (
      SELECT 1
      FROM app.assessment_mark_releases AS mark_release
      JOIN app.student_sections AS placement
        ON placement.section_id = mark_release.section_id
       AND placement.academic_year_id = mark_release.academic_year_id
       AND placement.school_id = mark_release.school_id
      WHERE mark_release.subject_id = target_subject_id
        AND mark_release.school_id = current_setting('app.school_id')::uuid
        AND mark_release.status = 'approved'
        AND app.is_related_to_student(placement.student_id)
    )
$function$;

RESET ROLE;
