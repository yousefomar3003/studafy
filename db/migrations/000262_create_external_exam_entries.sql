-- Exam entries (docs/plans/academic-phase2.md, WS-I): entering students for external exams.
--
-- Builds on 000255's catalogue (app.external_exams). A school runs a SESSION of a catalogue exam --
-- "IGCSE May/June 2027": its series name, the board's entry deadline, when the papers are sat and
-- when results are published -- and ENTERS students into it: one entry per student per session,
-- with the subjects entered (a per-subject exam: IGCSE, A Level, AP), each with its tier where the
-- exam has one (Core / Extended, Foundation / Higher) and the board's syllabus or option code, a
-- candidate number unique within the session, a status and a note.
--
--   draft      the school is still planning: nothing has been sent to the board. Deletable.
--   entered    sent to the board (entered_at). Shown to the student and their parents.
--   withdrawn  withdrawn after being entered (withdrawn_at); kept, and can be reinstated.
--
-- Results recorded later (000255's app.student_external_exam_results) may point back at the entry
-- they came from through a new, optional entry_id; the composite key holds the result to the
-- entry's own student and exam.
--
-- VISIBILITY. Sessions are configuration (tenant isolation only), like the catalogue. Entries and
-- their subjects are a student's personal data and follow app.can_read_student (leadership, a
-- teacher of the student, the student, linked parents) through a restrictive SELECT policy; the
-- API shows a student and their parents only entries that were actually entered. The GDPR
-- pipeline finds both by their student_id column; `note` is a personal-data column by name.
--
-- Depends on 000255 (external exams and results), 000008 (students, users), 000009 (subjects),
-- 000037 (app.can_read_student).

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Sessions
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.external_exam_sessions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_external_exam_sessions PRIMARY KEY,
  school_id uuid NOT NULL,
  exam_id uuid NOT NULL,
  -- The series as the board names it: "May/June 2027", "Summer 2027", "Winter session 2026".
  series text NOT NULL,
  entry_deadline date,
  starts_on date,
  ends_on date,
  results_date date,
  note text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_external_exam_sessions_id_exam_school UNIQUE (id, exam_id, school_id),
  CONSTRAINT fk_external_exam_sessions_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_external_exam_sessions_exam FOREIGN KEY (exam_id, school_id)
    REFERENCES app.external_exams (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_external_exam_sessions_series CHECK (
    series = btrim(series) AND series <> '' AND char_length(series) <= 120
  ),
  CONSTRAINT ck_external_exam_sessions_dates CHECK (
    (entry_deadline IS NULL OR entry_deadline >= DATE '1950-01-01')
    AND (starts_on IS NULL OR starts_on >= DATE '1950-01-01')
    AND (results_date IS NULL OR results_date >= DATE '1950-01-01')
    AND (ends_on IS NULL OR (starts_on IS NOT NULL AND ends_on >= starts_on))
  ),
  CONSTRAINT ck_external_exam_sessions_note CHECK (
    note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 1000)
  ),
  CONSTRAINT ck_external_exam_sessions_timestamps CHECK (updated_at >= created_at)
);

-- One session per series of an exam, whatever the case.
CREATE UNIQUE INDEX uq_external_exam_sessions_exam_series
  ON app.external_exam_sessions (school_id, exam_id, lower(series));
-- The school's sessions, latest first (the web list); the plain school_id-leading index RLS needs.
CREATE INDEX idx_external_exam_sessions_school_starts
  ON app.external_exam_sessions (school_id, starts_on DESC);
CREATE INDEX idx_external_exam_sessions_exam_fk
  ON app.external_exam_sessions (exam_id, school_id);

-- ---------------------------------------------------------------------------------------------------
-- 2. Entries
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.external_exam_entries (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_external_exam_entries PRIMARY KEY,
  school_id uuid NOT NULL,
  session_id uuid NOT NULL,
  -- The session's exam, carried so a result can be held to an entry of its own exam.
  exam_id uuid NOT NULL,
  student_id uuid NOT NULL,
  -- Unique within the session (any case); withdrawn entries keep theirs.
  candidate_number text,
  status text NOT NULL DEFAULT 'draft',
  note text,
  entered_at timestamptz,
  withdrawn_at timestamptz,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_external_exam_entries_session_student UNIQUE (school_id, session_id, student_id),
  CONSTRAINT uq_external_exam_entries_id_student_school UNIQUE (id, student_id, school_id),
  CONSTRAINT uq_external_exam_entries_id_student_exam_school
    UNIQUE (id, student_id, exam_id, school_id),
  CONSTRAINT fk_external_exam_entries_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_external_exam_entries_session FOREIGN KEY (session_id, exam_id, school_id)
    REFERENCES app.external_exam_sessions (id, exam_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_external_exam_entries_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_external_exam_entries_created_by FOREIGN KEY (created_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_external_exam_entries_candidate_number CHECK (
    candidate_number IS NULL OR (
      candidate_number = btrim(candidate_number) AND candidate_number <> ''
      AND char_length(candidate_number) <= 20
    )
  ),
  CONSTRAINT ck_external_exam_entries_status CHECK (status IN ('draft', 'entered', 'withdrawn')),
  -- draft: neither stamp; entered: entered_at; withdrawn: both (only an entered entry withdraws).
  CONSTRAINT ck_external_exam_entries_status_stamps CHECK (
    (status = 'draft' AND entered_at IS NULL AND withdrawn_at IS NULL)
    OR (status = 'entered' AND entered_at IS NOT NULL AND withdrawn_at IS NULL)
    OR (status = 'withdrawn' AND entered_at IS NOT NULL AND withdrawn_at IS NOT NULL)
  ),
  CONSTRAINT ck_external_exam_entries_note CHECK (
    note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 1000)
  ),
  CONSTRAINT ck_external_exam_entries_timestamps CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX uq_external_exam_entries_candidate_number
  ON app.external_exam_entries (school_id, session_id, lower(candidate_number))
  WHERE candidate_number IS NOT NULL;
-- A student's entries (the student page and the apps).
CREATE INDEX idx_external_exam_entries_student
  ON app.external_exam_entries (school_id, student_id);
CREATE INDEX idx_external_exam_entries_session_fk
  ON app.external_exam_entries (session_id, exam_id, school_id);
CREATE INDEX idx_external_exam_entries_student_fk
  ON app.external_exam_entries (student_id, school_id);
CREATE INDEX idx_external_exam_entries_created_by_fk
  ON app.external_exam_entries (created_by_user_id, school_id);

CREATE TABLE app.external_exam_entry_subjects (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_external_exam_entry_subjects PRIMARY KEY,
  school_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  -- Carried so visibility follows the student without a join and the GDPR pipeline reaches it;
  -- the composite key below holds it equal to the entry's.
  student_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  -- Where the exam is tiered: "Core", "Extended", "Foundation", "Higher".
  tier text,
  -- The board's syllabus, component or option code: "0580", "9709/12".
  option_code text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_external_exam_entry_subjects_entry_subject UNIQUE (school_id, entry_id, subject_id),
  CONSTRAINT fk_external_exam_entry_subjects_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Deleting a (draft) entry deletes its subjects with it.
  CONSTRAINT fk_external_exam_entry_subjects_entry FOREIGN KEY (entry_id, student_id, school_id)
    REFERENCES app.external_exam_entries (id, student_id, school_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_external_exam_entry_subjects_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_external_exam_entry_subjects_tier CHECK (
    tier IS NULL OR (tier = btrim(tier) AND tier <> '' AND char_length(tier) <= 40)
  ),
  CONSTRAINT ck_external_exam_entry_subjects_option_code CHECK (
    option_code IS NULL OR (
      option_code = btrim(option_code) AND option_code <> '' AND char_length(option_code) <= 40
    )
  )
);

CREATE INDEX idx_external_exam_entry_subjects_entry_fk
  ON app.external_exam_entry_subjects (entry_id, student_id, school_id);
CREATE INDEX idx_external_exam_entry_subjects_subject_fk
  ON app.external_exam_entry_subjects (subject_id, school_id);

-- ---------------------------------------------------------------------------------------------------
-- 3. Results link back to their entry
-- ---------------------------------------------------------------------------------------------------

-- Optional and additive: results recorded before this migration, or without an entry, keep NULL.
-- MATCH SIMPLE: with entry_id NULL the key is not checked; set, it must be an entry of the
-- result's own student and exam. An entry with results cannot be deleted.
ALTER TABLE app.student_external_exam_results
  ADD COLUMN entry_id uuid,
  ADD CONSTRAINT fk_student_external_exam_results_entry
    FOREIGN KEY (entry_id, student_id, exam_id, school_id)
    REFERENCES app.external_exam_entries (id, student_id, exam_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE INDEX idx_student_external_exam_results_entry_fk
  ON app.student_external_exam_results (entry_id, student_id, exam_id, school_id)
  WHERE entry_id IS NOT NULL;

COMMENT ON TABLE app.external_exam_sessions IS
  'A series of a catalogue external exam the school enters students for: entry deadline, sitting dates, results date (000262).';
COMMENT ON TABLE app.external_exam_entries IS
  'A student entered for an external exam session: candidate number, status draft/entered/withdrawn (000262).';
COMMENT ON TABLE app.external_exam_entry_subjects IS
  'A subject an exam entry covers, with its tier and the board''s option code (000262); deleted with the entry.';
COMMENT ON COLUMN app.student_external_exam_results.entry_id IS
  'The exam entry this result came from, when known (000262).';

-- ---------------------------------------------------------------------------------------------------
-- 4. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE
  app.external_exam_sessions, app.external_exam_entries, app.external_exam_entry_subjects
FROM PUBLIC, studafy_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.external_exam_sessions, app.external_exam_entries, app.external_exam_entry_subjects
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'external_exam_sessions');
SELECT app.apply_tenant_isolation('app', 'external_exam_entries');
SELECT app.apply_tenant_isolation('app', 'external_exam_entry_subjects');

CREATE POLICY role_scope_visibility ON app.external_exam_entries
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student(student_id));

CREATE POLICY role_scope_visibility ON app.external_exam_entry_subjects
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_student(student_id));

-- The subjects of a student's exam entries, for whoever may read the student. As with
-- app.external_exam_result_subjects (000255): app.subjects is role-scoped, so a student or parent
-- would not see an IGCSE subject they take no class in. Reads as its owner -- still under tenant
-- isolation -- and checks the caller itself, revealing a subject's code and name only beside an
-- entry the caller can already read.
CREATE FUNCTION app.external_exam_entry_subjects_of(target_student_id uuid)
RETURNS TABLE (subject_id uuid, code text, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT DISTINCT subject.id, subject.code, subject.name
  FROM app.external_exam_entry_subjects AS entered
  JOIN app.subjects AS subject
    ON subject.id = entered.subject_id AND subject.school_id = entered.school_id
  WHERE entered.school_id = current_setting('app.school_id')::uuid
    AND entered.student_id = target_student_id
    AND app.can_read_student(target_student_id)
$function$;

ALTER FUNCTION app.external_exam_entry_subjects_of(uuid) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.external_exam_entry_subjects_of(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.external_exam_entry_subjects_of(uuid) TO studafy_app;

RESET ROLE;
