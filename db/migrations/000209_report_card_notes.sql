-- Report card notes: comments, an attendance summary and a conduct rating on term report cards and
-- annual certificates.
--
-- WHAT IS WRITTEN WHEN.
--   While a section's term (or year) is open, staff write draft notes:
--     report_subject_comments  one comment per student per subject, from that subject's teacher;
--     report_student_notes     the class teacher's overall comment and conduct rating, and an
--                              optional principal comment, per student.
--   Finalizing the section's results (or a correction, which writes a new finalization version)
--   copies them, with the attendance summary for the period, into two append-only snapshot tables:
--     finalized_report_notes      one row per student of the finalization;
--     finalized_subject_comments  one row per student and subject that has a comment.
--   Certificates are rendered from the snapshot, so a later edit to a draft note never reaches a
--   finalized result or an issued certificate. Finalizations made before this migration have no
--   snapshot rows and render exactly as before.
--
-- WHICH SECTIONS APPEAR is a per-school choice (report_card_settings; no row means every section
-- is shown). A section switched off is simply not copied into the snapshot.
--
-- CONDUCT is a school-defined list (report_conduct_ratings; no rows means the default four:
-- excellent, very good, good, needs improvement). The snapshot stores the chosen code and both
-- labels as they were at finalization, so renaming a rating later never rewrites a report card.
--
-- PRIVACY. Draft notes are staff data: school leadership, or a teacher of the section. Students and
-- parents read only the finalized snapshot, through the same rule as finalized results
-- (app.can_read_student_result). Discipline incidents are never copied anywhere here.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Per-school settings
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.report_card_settings (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_report_card_settings PRIMARY KEY,
  school_id uuid NOT NULL,
  show_subject_comments boolean NOT NULL DEFAULT true,
  show_teacher_comment boolean NOT NULL DEFAULT true,
  show_principal_comment boolean NOT NULL DEFAULT true,
  show_attendance boolean NOT NULL DEFAULT true,
  show_conduct boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_report_card_settings_school UNIQUE (school_id),
  CONSTRAINT fk_report_card_settings_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_report_card_settings_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.report_conduct_ratings (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_report_conduct_ratings PRIMARY KEY,
  school_id uuid NOT NULL,
  code text NOT NULL,
  label text NOT NULL,
  label_ar text,
  sort_order smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_report_conduct_ratings_school_code UNIQUE (school_id, code),
  CONSTRAINT fk_report_conduct_ratings_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_report_conduct_ratings_code CHECK (code ~ '^[a-z0-9_]{1,40}$'),
  CONSTRAINT ck_report_conduct_ratings_label
    CHECK (label = btrim(label) AND label <> '' AND char_length(label) <= 60),
  CONSTRAINT ck_report_conduct_ratings_label_ar CHECK (
    label_ar IS NULL OR (label_ar = btrim(label_ar) AND label_ar <> '' AND char_length(label_ar) <= 60)
  ),
  CONSTRAINT ck_report_conduct_ratings_sort CHECK (sort_order >= 0)
);

-- ---------------------------------------------------------------------------------------------------
-- 2. Draft notes (editable until the period is finalized)
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.report_subject_comments (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_report_subject_comments PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  section_id uuid NOT NULL,
  -- NULL: the annual report (certificate) rather than one term's report card.
  term_id uuid,
  student_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  body text NOT NULL,
  author_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_report_subject_comments_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_report_subject_comments_section FOREIGN KEY (section_id, academic_year_id, school_id)
    REFERENCES app.sections (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_report_subject_comments_term FOREIGN KEY (term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_report_subject_comments_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_report_subject_comments_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_report_subject_comments_author FOREIGN KEY (author_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_report_subject_comments_body
    CHECK (btrim(body) <> '' AND char_length(body) <= 1000),
  CONSTRAINT ck_report_subject_comments_timestamps CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX uq_report_subject_comments_term
  ON app.report_subject_comments (school_id, section_id, term_id, student_id, subject_id)
  WHERE term_id IS NOT NULL;
CREATE UNIQUE INDEX uq_report_subject_comments_annual
  ON app.report_subject_comments (school_id, section_id, student_id, subject_id)
  WHERE term_id IS NULL;
CREATE INDEX idx_report_subject_comments_section_fk
  ON app.report_subject_comments (section_id, academic_year_id, school_id);
CREATE INDEX idx_report_subject_comments_term_fk
  ON app.report_subject_comments (term_id, academic_year_id, school_id) WHERE term_id IS NOT NULL;
CREATE INDEX idx_report_subject_comments_student_fk
  ON app.report_subject_comments (student_id, school_id);
CREATE INDEX idx_report_subject_comments_subject_fk
  ON app.report_subject_comments (subject_id, school_id);
CREATE INDEX idx_report_subject_comments_author_fk
  ON app.report_subject_comments (author_user_id, school_id);

CREATE TABLE app.report_student_notes (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_report_student_notes PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  section_id uuid NOT NULL,
  term_id uuid,
  student_id uuid NOT NULL,
  teacher_comment text,
  teacher_comment_by_user_id uuid,
  principal_comment text,
  principal_comment_by_user_id uuid,
  conduct_code text,
  conduct_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_report_student_notes_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_report_student_notes_section FOREIGN KEY (section_id, academic_year_id, school_id)
    REFERENCES app.sections (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_report_student_notes_term FOREIGN KEY (term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_report_student_notes_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_report_student_notes_teacher_by FOREIGN KEY (teacher_comment_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_report_student_notes_principal_by FOREIGN KEY (principal_comment_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_report_student_notes_conduct_by FOREIGN KEY (conduct_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_report_student_notes_teacher_comment CHECK (
    teacher_comment IS NULL OR (btrim(teacher_comment) <> '' AND char_length(teacher_comment) <= 1000)
  ),
  CONSTRAINT ck_report_student_notes_principal_comment CHECK (
    principal_comment IS NULL
    OR (btrim(principal_comment) <> '' AND char_length(principal_comment) <= 1000)
  ),
  CONSTRAINT ck_report_student_notes_conduct_code
    CHECK (conduct_code IS NULL OR conduct_code ~ '^[a-z0-9_]{1,40}$'),
  CONSTRAINT ck_report_student_notes_timestamps CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX uq_report_student_notes_term
  ON app.report_student_notes (school_id, section_id, term_id, student_id)
  WHERE term_id IS NOT NULL;
CREATE UNIQUE INDEX uq_report_student_notes_annual
  ON app.report_student_notes (school_id, section_id, student_id)
  WHERE term_id IS NULL;
CREATE INDEX idx_report_student_notes_section_fk
  ON app.report_student_notes (section_id, academic_year_id, school_id);
CREATE INDEX idx_report_student_notes_term_fk
  ON app.report_student_notes (term_id, academic_year_id, school_id) WHERE term_id IS NOT NULL;
CREATE INDEX idx_report_student_notes_student_fk ON app.report_student_notes (student_id, school_id);
CREATE INDEX idx_report_student_notes_teacher_by_fk
  ON app.report_student_notes (teacher_comment_by_user_id, school_id)
  WHERE teacher_comment_by_user_id IS NOT NULL;
CREATE INDEX idx_report_student_notes_principal_by_fk
  ON app.report_student_notes (principal_comment_by_user_id, school_id)
  WHERE principal_comment_by_user_id IS NOT NULL;
CREATE INDEX idx_report_student_notes_conduct_by_fk
  ON app.report_student_notes (conduct_by_user_id, school_id)
  WHERE conduct_by_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------
-- 3. Finalized snapshot (append-only, like the results it belongs to)
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.finalized_report_notes (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_finalized_report_notes PRIMARY KEY,
  school_id uuid NOT NULL,
  finalization_id uuid NOT NULL,
  student_id uuid NOT NULL,
  teacher_comment text,
  principal_comment text,
  conduct_code text,
  conduct_label text,
  conduct_label_ar text,
  -- Days in the period with attendance recorded for the student, split by outcome (see the API's
  -- report-card-service: a day is present if the student attended any session that day, late if
  -- any of those was late, otherwise absent or excused). All NULL when attendance is not shown.
  attendance_from date,
  attendance_to date,
  attendance_days_recorded integer,
  attendance_days_present integer,
  attendance_days_absent integer,
  attendance_days_late integer,
  attendance_days_excused integer,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_finalized_report_notes_finalization_student
    UNIQUE (school_id, finalization_id, student_id),
  CONSTRAINT fk_finalized_report_notes_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_finalized_report_notes_overall FOREIGN KEY (finalization_id, student_id, school_id)
    REFERENCES app.student_overall_results (finalization_id, student_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_finalized_report_notes_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_finalized_report_notes_teacher_comment CHECK (
    teacher_comment IS NULL OR (btrim(teacher_comment) <> '' AND char_length(teacher_comment) <= 1000)
  ),
  CONSTRAINT ck_finalized_report_notes_principal_comment CHECK (
    principal_comment IS NULL
    OR (btrim(principal_comment) <> '' AND char_length(principal_comment) <= 1000)
  ),
  CONSTRAINT ck_finalized_report_notes_conduct CHECK (
    (conduct_code IS NULL) = (conduct_label IS NULL)
    AND (conduct_code IS NOT NULL OR conduct_label_ar IS NULL)
  ),
  CONSTRAINT ck_finalized_report_notes_attendance CHECK (
    (
      attendance_from IS NULL AND attendance_to IS NULL AND attendance_days_recorded IS NULL
      AND attendance_days_present IS NULL AND attendance_days_absent IS NULL
      AND attendance_days_late IS NULL AND attendance_days_excused IS NULL
    )
    OR (
      attendance_from IS NOT NULL AND attendance_to IS NOT NULL AND attendance_to >= attendance_from
      AND attendance_days_present >= 0 AND attendance_days_absent >= 0
      AND attendance_days_late >= 0 AND attendance_days_excused >= 0
      AND attendance_days_late <= attendance_days_present
      AND attendance_days_recorded
        = attendance_days_present + attendance_days_absent + attendance_days_excused
    )
  )
);
CREATE INDEX idx_finalized_report_notes_overall_fk
  ON app.finalized_report_notes (finalization_id, student_id, school_id);
CREATE INDEX idx_finalized_report_notes_student_fk
  ON app.finalized_report_notes (student_id, school_id);

CREATE TABLE app.finalized_subject_comments (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_finalized_subject_comments PRIMARY KEY,
  school_id uuid NOT NULL,
  finalization_id uuid NOT NULL,
  student_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_finalized_subject_comments_result
    UNIQUE (school_id, finalization_id, student_id, subject_id),
  CONSTRAINT fk_finalized_subject_comments_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Only a subject the student has a finalized result in can carry a finalized comment.
  CONSTRAINT fk_finalized_subject_comments_result
    FOREIGN KEY (school_id, finalization_id, student_id, subject_id)
    REFERENCES app.student_subject_results (school_id, finalization_id, student_id, subject_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_finalized_subject_comments_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_finalized_subject_comments_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_finalized_subject_comments_body
    CHECK (btrim(body) <> '' AND char_length(body) <= 1000)
);
CREATE INDEX idx_finalized_subject_comments_student_fk
  ON app.finalized_subject_comments (student_id, school_id);
CREATE INDEX idx_finalized_subject_comments_subject_fk
  ON app.finalized_subject_comments (subject_id, school_id);

-- ---------------------------------------------------------------------------------------------------
-- 4. Who may read draft notes
-- ---------------------------------------------------------------------------------------------------

-- True when the current user teaches anything in `target_section_id`: an explicit subject
-- assignment, or a class of that section (lead teacher or timetable slot, app.teaches_class).
CREATE FUNCTION app.teaches_in_section(target_section_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.current_user_teacher_id() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM app.section_subject_teachers AS assignment
        WHERE assignment.school_id = current_setting('app.school_id')::uuid
          AND assignment.section_id = target_section_id
          AND assignment.teacher_id = app.current_user_teacher_id()
      )
      OR EXISTS (
        SELECT 1
        FROM app.classes AS class
        WHERE class.school_id = current_setting('app.school_id')::uuid
          AND class.section_id = target_section_id
          AND app.teaches_class(class.id)
      )
    )
$function$;

ALTER FUNCTION app.teaches_in_section(uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.teaches_in_section(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.teaches_in_section(uuid) TO studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 5. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE
  app.report_card_settings, app.report_conduct_ratings, app.report_subject_comments,
  app.report_student_notes, app.finalized_report_notes, app.finalized_subject_comments
FROM PUBLIC, studafy_app;

GRANT SELECT, INSERT, UPDATE ON TABLE app.report_card_settings TO studafy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.report_conduct_ratings, app.report_subject_comments, app.report_student_notes
TO studafy_app;
-- The snapshot is append-only, like app.student_subject_results and app.student_overall_results.
GRANT SELECT, INSERT ON TABLE app.finalized_report_notes, app.finalized_subject_comments TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'report_card_settings');
SELECT app.apply_tenant_isolation('app', 'report_conduct_ratings');
SELECT app.apply_tenant_isolation('app', 'report_subject_comments');
SELECT app.apply_tenant_isolation('app', 'report_student_notes');
SELECT app.apply_tenant_isolation('app', 'finalized_report_notes');
SELECT app.apply_tenant_isolation('app', 'finalized_subject_comments');

-- Settings and the conduct list are configuration (tenant isolation only): a teacher's screen shows
-- the ratings it picks from. Draft notes are staff-only; the snapshot follows finalized results.
CREATE POLICY role_scope_visibility ON app.report_subject_comments
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.current_user_is_school_admin() OR app.teaches_in_section(section_id));

CREATE POLICY role_scope_visibility ON app.report_student_notes
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.current_user_is_school_admin() OR app.teaches_in_section(section_id));

CREATE POLICY role_scope_visibility ON app.finalized_report_notes
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student_result(student_id, finalization_id));

CREATE POLICY role_scope_visibility ON app.finalized_subject_comments
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student_result(student_id, finalization_id));

COMMENT ON TABLE app.report_card_settings IS
  'Which report card sections a school shows: subject comments, teacher and principal comments, attendance, conduct (000209). No row: all shown.';
COMMENT ON TABLE app.report_conduct_ratings IS
  'The school''s conduct ratings for report cards (000209). No rows: the default four.';
COMMENT ON TABLE app.report_subject_comments IS
  'Draft per-subject report card comment for a student and period, from the subject teacher (000209).';
COMMENT ON TABLE app.report_student_notes IS
  'Draft class teacher comment, principal comment and conduct rating for a student and period (000209).';
COMMENT ON TABLE app.finalized_report_notes IS
  'Append-only snapshot of a student''s report card notes and attendance summary at finalization (000209).';
COMMENT ON TABLE app.finalized_subject_comments IS
  'Append-only snapshot of a student''s per-subject report card comments at finalization (000209).';

RESET ROLE;
