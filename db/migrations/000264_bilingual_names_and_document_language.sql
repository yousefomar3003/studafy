-- Arabic + English documents (docs/plans/academic-phase2.md, WS-K).
--
-- 1. ARABIC NAMES. Optional Arabic names beside the English ones a school already keeps:
--      app.students        first_name_ar, middle_name_ar, last_name_ar
--      app.subjects        name_ar
--      app.grade_levels    name_ar
--      app.sections        name_ar
--      app.schools         name_ar
--      app.terms           name_ar
--      app.academic_years  name_ar
--    All nullable: NULL means "no Arabic name", and every reader falls back to the English name.
--    Trimmed and non-blank when set, like the English columns' checks.
--
-- 2. DOCUMENT LANGUAGE. app.document_language_settings holds, per school, the language each kind
--    of issued document is rendered in: report cards (term reports), annual certificates and
--    transcripts. 'viewer' (the default, and what having no row means) keeps the behaviour before
--    this migration: the document shows each reader's own language. 'en', 'ar' and 'bilingual'
--    fix the language at issue: the choice and the Arabic names are copied into the document's
--    immutable content (000207 / ADR-017), so a later change of setting or name never alters an
--    issued document. Documents issued before carry neither and render as they did.
--
-- 3. SUBJECT ARABIC NAMES FOR READERS. app.subjects is role-scoped (000037): a student or parent
--    may not read the subject row behind a result they can read. app.subject_names_ar returns only
--    the Arabic names of the subjects asked for, in the caller's school, so results, courses and
--    documents can show them. It reveals nothing beyond a translated name of a subject the caller
--    already sees by its English name, and does not widen app.subjects' policy.
--
-- 4. SEARCH. The global search candidate functions (000171) also match a student's Arabic name.
--    The stored search_tsv / search_name columns are left as they are: changing a generated column
--    means dropping and re-adding it (a rewrite of app.students). The Arabic name is matched on the
--    fly instead, only for rows that have one, over the one school's rows the scan already bounds.
--
-- Expand only: new nullable columns, a new table, and functions replaced with the same signature.

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Arabic names
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.students
  ADD COLUMN first_name_ar text,
  ADD COLUMN middle_name_ar text,
  ADD COLUMN last_name_ar text,
  ADD CONSTRAINT ck_students_first_name_ar CHECK (
    first_name_ar IS NULL
    OR (first_name_ar = btrim(first_name_ar) AND first_name_ar <> '' AND char_length(first_name_ar) <= 100)
  ),
  ADD CONSTRAINT ck_students_middle_name_ar CHECK (
    middle_name_ar IS NULL
    OR (middle_name_ar = btrim(middle_name_ar) AND middle_name_ar <> '' AND char_length(middle_name_ar) <= 100)
  ),
  ADD CONSTRAINT ck_students_last_name_ar CHECK (
    last_name_ar IS NULL
    OR (last_name_ar = btrim(last_name_ar) AND last_name_ar <> '' AND char_length(last_name_ar) <= 100)
  );

COMMENT ON COLUMN app.students.first_name_ar IS 'Arabic first name; NULL when the school keeps none.';
COMMENT ON COLUMN app.students.middle_name_ar IS 'Arabic middle (father''s) name; NULL for none.';
COMMENT ON COLUMN app.students.last_name_ar IS 'Arabic family name; NULL when the school keeps none.';

ALTER TABLE app.subjects
  ADD COLUMN name_ar text,
  ADD CONSTRAINT ck_subjects_name_ar CHECK (
    name_ar IS NULL OR (name_ar = btrim(name_ar) AND name_ar <> '' AND char_length(name_ar) <= 200)
  );

ALTER TABLE app.grade_levels
  ADD COLUMN name_ar text,
  ADD CONSTRAINT ck_grade_levels_name_ar CHECK (
    name_ar IS NULL OR (name_ar = btrim(name_ar) AND name_ar <> '' AND char_length(name_ar) <= 200)
  );

ALTER TABLE app.sections
  ADD COLUMN name_ar text,
  ADD CONSTRAINT ck_sections_name_ar CHECK (
    name_ar IS NULL OR (name_ar = btrim(name_ar) AND name_ar <> '' AND char_length(name_ar) <= 200)
  );

ALTER TABLE app.schools
  ADD COLUMN name_ar text,
  ADD CONSTRAINT ck_schools_name_ar CHECK (
    name_ar IS NULL OR (name_ar = btrim(name_ar) AND name_ar <> '' AND char_length(name_ar) <= 200)
  );

ALTER TABLE app.terms
  ADD COLUMN name_ar text,
  ADD CONSTRAINT ck_terms_name_ar CHECK (
    name_ar IS NULL OR (name_ar = btrim(name_ar) AND name_ar <> '' AND char_length(name_ar) <= 200)
  );

ALTER TABLE app.academic_years
  ADD COLUMN name_ar text,
  ADD CONSTRAINT ck_academic_years_name_ar CHECK (
    name_ar IS NULL OR (name_ar = btrim(name_ar) AND name_ar <> '' AND char_length(name_ar) <= 200)
  );

COMMENT ON COLUMN app.subjects.name_ar IS 'Arabic name; NULL falls back to name.';
COMMENT ON COLUMN app.grade_levels.name_ar IS 'Arabic name; NULL falls back to name.';
COMMENT ON COLUMN app.sections.name_ar IS 'Arabic name; NULL falls back to name.';
COMMENT ON COLUMN app.schools.name_ar IS 'Arabic name shown on documents; NULL falls back to name.';
COMMENT ON COLUMN app.terms.name_ar IS 'Arabic name; NULL falls back to name.';
COMMENT ON COLUMN app.academic_years.name_ar IS 'Arabic name; NULL falls back to name.';

-- ---------------------------------------------------------------------------------------------------
-- 2. Document language per school and document type
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.document_language_settings (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_document_language_settings PRIMARY KEY,
  school_id uuid NOT NULL,
  report_card_language text NOT NULL DEFAULT 'viewer',
  certificate_language text NOT NULL DEFAULT 'viewer',
  transcript_language text NOT NULL DEFAULT 'viewer',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_document_language_settings_school UNIQUE (school_id),
  CONSTRAINT fk_document_language_settings_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_document_language_settings_report_card
    CHECK (report_card_language IN ('viewer', 'en', 'ar', 'bilingual')),
  CONSTRAINT ck_document_language_settings_certificate
    CHECK (certificate_language IN ('viewer', 'en', 'ar', 'bilingual')),
  CONSTRAINT ck_document_language_settings_transcript
    CHECK (transcript_language IN ('viewer', 'en', 'ar', 'bilingual')),
  CONSTRAINT ck_document_language_settings_timestamps CHECK (updated_at >= created_at)
);

COMMENT ON TABLE app.document_language_settings IS
  'The language each kind of issued document is rendered in (viewer, en, ar, bilingual); no row means viewer for all.';

REVOKE ALL PRIVILEGES ON TABLE app.document_language_settings FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.document_language_settings TO studafy_app;

-- Configuration, not personal data: tenant isolation only (like app.report_card_settings).
SELECT app.apply_tenant_isolation('app', 'document_language_settings');

-- ---------------------------------------------------------------------------------------------------
-- 3. Arabic subject names for any reader of the school
-- ---------------------------------------------------------------------------------------------------

CREATE FUNCTION app.subject_names_ar(target_subject_ids uuid[])
RETURNS TABLE (subject_id uuid, name_ar text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT subject.id, subject.name_ar
  FROM app.subjects AS subject
  WHERE subject.school_id = current_setting('app.school_id')::uuid
    AND subject.id = ANY (target_subject_ids)
    AND subject.name_ar IS NOT NULL
$function$;

ALTER FUNCTION app.subject_names_ar(uuid[]) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.subject_names_ar(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.subject_names_ar(uuid[]) TO studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 4. Global search: students also match by their Arabic name
-- ---------------------------------------------------------------------------------------------------

-- The normalized Arabic full name, '' when the student has none (STRICT is avoided on purpose:
-- concat_ws skips NULL parts).
CREATE FUNCTION app.student_search_name_ar(first_name_ar text, middle_name_ar text, last_name_ar text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
RETURN app.search_normalize(pg_catalog.concat_ws(' ', first_name_ar, middle_name_ar, last_name_ar));

REVOKE ALL ON FUNCTION app.student_search_name_ar(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.student_search_name_ar(text, text, text) TO studafy_app;

-- Same bodies as 000171 except the 'students' branches, which add the Arabic-name disjunct.
CREATE OR REPLACE FUNCTION app.search_scoped_ids(kind text, query tsquery)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
ROWS 20
SET search_path = pg_catalog
AS $function$
BEGIN
  IF kind = 'students' THEN
    RETURN QUERY
      SELECT s.id FROM app.students AS s
      WHERE s.school_id = current_setting('app.school_id')::uuid
        AND (
          s.search_tsv @@ query
          OR (
            (s.first_name_ar IS NOT NULL OR s.last_name_ar IS NOT NULL)
            AND to_tsvector(
              'simple',
              app.search_document(pg_catalog.concat_ws(' ', s.first_name_ar, s.middle_name_ar, s.last_name_ar))
            ) @@ query
          )
        );
  ELSIF kind = 'classes' THEN
    RETURN QUERY
      SELECT cl.id
      FROM app.classes AS cl
      LEFT JOIN app.courses AS co ON co.id = cl.course_id AND co.school_id = cl.school_id
      WHERE cl.school_id = current_setting('app.school_id')::uuid
        AND (cl.search_tsv || coalesce(co.search_tsv, ''::tsvector)) @@ query;
  ELSIF kind = 'subjects' THEN
    RETURN QUERY
      SELECT su.id FROM app.subjects AS su
      WHERE su.school_id = current_setting('app.school_id')::uuid AND su.search_tsv @@ query;
  ELSIF kind = 'materials' THEN
    RETURN QUERY
      SELECT m.id FROM app.materials AS m
      WHERE m.school_id = current_setting('app.school_id')::uuid AND m.search_tsv @@ query;
  ELSE
    RAISE EXCEPTION 'app.search_scoped_ids: unknown kind %', kind USING ERRCODE = '22023';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION app.search_scoped_fuzzy_ids(kind text, query text)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
ROWS 20
SET search_path = pg_catalog
AS $function$
BEGIN
  IF kind = 'students' THEN
    RETURN QUERY
      SELECT s.id FROM app.students AS s
      WHERE s.school_id = current_setting('app.school_id')::uuid
        AND (
          query OPERATOR(public.<%) s.search_name
          OR (
            (s.first_name_ar IS NOT NULL OR s.last_name_ar IS NOT NULL)
            AND query OPERATOR(public.<%)
              app.student_search_name_ar(s.first_name_ar, s.middle_name_ar, s.last_name_ar)
          )
        );
  ELSIF kind = 'classes' THEN
    RETURN QUERY
      SELECT cl.id FROM app.classes AS cl
      WHERE cl.school_id = current_setting('app.school_id')::uuid
        AND query OPERATOR(public.<%) cl.search_name;
  ELSIF kind = 'subjects' THEN
    RETURN QUERY
      SELECT su.id FROM app.subjects AS su
      WHERE su.school_id = current_setting('app.school_id')::uuid
        AND query OPERATOR(public.<%) su.search_name;
  ELSE
    RAISE EXCEPTION 'app.search_scoped_fuzzy_ids: unknown kind %', kind USING ERRCODE = '22023';
  END IF;
END;
$function$;

RESET ROLE;
