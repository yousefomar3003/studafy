-- School-defined student and parent records (docs/modules/student-records.md, ADR-019).
--
-- Every school asks for different things about a student and their parents (a birth certificate, a
-- vaccination record, a bus stop, a passport number). A school builds one template per subject
-- ("student" | "parent") and its staff fill in the answers. Studafy never asks for any of it and
-- never matches, dedupes or links people on it.
--
-- 1. app.record_templates          -- one per (school, subject), carrying the published version.
-- 2. app.record_fields             -- stable field identity + the *draft* definition staff edit.
-- 3. app.record_template_versions  -- one row per publish.
--    app.record_field_versions     -- the field definitions exactly as published in that version.
--    Answers point at the field version they were given under, so a later label, choice or
--    required change never rewrites what an old answer meant.
-- 4. app.record_answers            -- one per (subject, field). A sensitive answer is stored only
--    as AES-256-GCM ciphertext plus a precomputed mask (ADR-019); its plaintext column is NULL.
-- 5. app.record_documents          -- the stored file behind a document field's answer.
-- 6. app.students.left_at          -- when a student left (graduated / withdrawn / archived), the
--    clock the sensitive-field retention job counts from.
--
-- Nothing collected is deleted by a template edit: archiving a field sets archived_at and keeps its
-- answers; only the retention job, DSR erasure, and deleting the subject itself remove answers.
--
-- ROW SCOPE. Tenant isolation on every table. Answers and documents also get a RESTRICTIVE SELECT
-- role_scope_visibility policy that reuses the existing predicates (000037 / 000120 / 000160):
-- a student's answers follow app.can_read_student (leadership, a teacher of the student, the
-- student's linked parents); a parent's answers are leadership-only. Field visibility and
-- sensitivity are narrowed by the application on top of that. SELECT only, as in 000037: writes
-- stay with tenant_isolation's WITH CHECK plus the permission matrix.

SET ROLE studafy_admin;

CREATE TYPE app.record_subject_kind AS ENUM ('student', 'parent');
CREATE TYPE app.record_field_type AS ENUM (
  'short_text', 'long_text', 'number', 'date', 'single_choice', 'multi_choice', 'yes_no', 'phone',
  'email', 'document'
);
-- A widening ladder: staff_only < finance < teachers < parent. "teachers" is also readable by
-- finance, and "parent" by teachers and finance. ORG_ADMIN and PRINCIPAL read every level.
CREATE TYPE app.record_field_visibility AS ENUM ('staff_only', 'finance', 'teachers', 'parent');
CREATE TYPE app.record_field_sensitivity AS ENUM ('standard', 'sensitive');
CREATE TYPE app.record_document_status AS ENUM ('missing', 'uploaded', 'verified');

-- 1 -------------------------------------------------------------------------------------------------

CREATE TABLE app.record_templates (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_record_templates PRIMARY KEY,
  school_id uuid NOT NULL,
  subject_kind app.record_subject_kind NOT NULL,
  -- 0 until the first publish. Answers can be written only against a published version.
  published_version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_record_templates_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_record_templates_school_subject UNIQUE (school_id, subject_kind),
  CONSTRAINT fk_record_templates_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_record_templates_published_version CHECK (published_version >= 0),
  CONSTRAINT ck_record_templates_timestamps CHECK (updated_at >= created_at)
);

REVOKE ALL PRIVILEGES ON TABLE app.record_templates FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE app.record_templates TO studafy_app;
SELECT app.apply_tenant_isolation('app', 'record_templates');

-- 2 -------------------------------------------------------------------------------------------------

CREATE TABLE app.record_fields (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_record_fields PRIMARY KEY,
  school_id uuid NOT NULL,
  template_id uuid NOT NULL,
  field_type app.record_field_type NOT NULL,
  label_en text NOT NULL,
  label_ar text NOT NULL,
  help_en text,
  help_ar text,
  required boolean NOT NULL DEFAULT false,
  -- [{ "value": "...", "label_en": "...", "label_ar": "..." }] for the choice types, [] otherwise.
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order int NOT NULL DEFAULT 0,
  visibility app.record_field_visibility NOT NULL DEFAULT 'staff_only',
  sensitivity app.record_field_sensitivity NOT NULL DEFAULT 'standard',
  has_expiry boolean NOT NULL DEFAULT false,
  -- Months after the subject leaves before the retention job deletes a sensitive answer. NULL
  -- means the platform default (12, docs/modules/student-records.md "Retention").
  retention_months int,
  -- Set the first time the field is published; a published field's type can no longer change.
  first_published_at timestamptz,
  archived_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_record_fields_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_record_fields_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_record_fields_template FOREIGN KEY (template_id, school_id)
    REFERENCES app.record_templates (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_record_fields_created_by FOREIGN KEY (created_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_record_fields_label_en CHECK (
    label_en = btrim(label_en) AND label_en <> '' AND char_length(label_en) <= 200
  ),
  CONSTRAINT ck_record_fields_label_ar CHECK (
    label_ar = btrim(label_ar) AND label_ar <> '' AND char_length(label_ar) <= 200
  ),
  CONSTRAINT ck_record_fields_help CHECK (
    (help_en IS NULL OR char_length(help_en) <= 1000)
    AND (help_ar IS NULL OR char_length(help_ar) <= 1000)
  ),
  CONSTRAINT ck_record_fields_options CHECK (
    jsonb_typeof(options) = 'array'
    AND (field_type IN ('single_choice', 'multi_choice') OR options = '[]'::jsonb)
  ),
  CONSTRAINT ck_record_fields_has_expiry CHECK (NOT has_expiry OR field_type = 'document'),
  CONSTRAINT ck_record_fields_retention CHECK (
    retention_months IS NULL
    OR (sensitivity = 'sensitive' AND retention_months BETWEEN 1 AND 120)
  ),
  CONSTRAINT ck_record_fields_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX ix_record_fields_school_template_sort
  ON app.record_fields (school_id, template_id, sort_order);

REVOKE ALL PRIVILEGES ON TABLE app.record_fields FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE app.record_fields TO studafy_app;
SELECT app.apply_tenant_isolation('app', 'record_fields');

-- 3 -------------------------------------------------------------------------------------------------

CREATE TABLE app.record_template_versions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_record_template_versions PRIMARY KEY,
  school_id uuid NOT NULL,
  template_id uuid NOT NULL,
  version int NOT NULL,
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_record_template_versions_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_record_template_versions_template_version UNIQUE (school_id, template_id, version),
  CONSTRAINT fk_record_template_versions_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_record_template_versions_template FOREIGN KEY (template_id, school_id)
    REFERENCES app.record_templates (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_record_template_versions_published_by FOREIGN KEY (published_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_record_template_versions_version CHECK (version >= 1)
);

REVOKE ALL PRIVILEGES ON TABLE app.record_template_versions FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE app.record_template_versions TO studafy_app;
SELECT app.apply_tenant_isolation('app', 'record_template_versions');

-- Immutable once written: a published version is a fact about the past.
CREATE TABLE app.record_field_versions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_record_field_versions PRIMARY KEY,
  school_id uuid NOT NULL,
  template_version_id uuid NOT NULL,
  field_id uuid NOT NULL,
  field_type app.record_field_type NOT NULL,
  label_en text NOT NULL,
  label_ar text NOT NULL,
  help_en text,
  help_ar text,
  required boolean NOT NULL,
  options jsonb NOT NULL,
  sort_order int NOT NULL,
  visibility app.record_field_visibility NOT NULL,
  sensitivity app.record_field_sensitivity NOT NULL,
  has_expiry boolean NOT NULL,
  retention_months int,
  CONSTRAINT uq_record_field_versions_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_record_field_versions_version_field
    UNIQUE (school_id, template_version_id, field_id),
  CONSTRAINT fk_record_field_versions_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_record_field_versions_template_version FOREIGN KEY (template_version_id, school_id)
    REFERENCES app.record_template_versions (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_record_field_versions_field FOREIGN KEY (field_id, school_id)
    REFERENCES app.record_fields (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX ix_record_field_versions_school_field
  ON app.record_field_versions (school_id, field_id);

REVOKE ALL PRIVILEGES ON TABLE app.record_field_versions FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE app.record_field_versions TO studafy_app;
SELECT app.apply_tenant_isolation('app', 'record_field_versions');

-- 4 -------------------------------------------------------------------------------------------------

CREATE TABLE app.record_answers (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_record_answers PRIMARY KEY,
  school_id uuid NOT NULL,
  subject_kind app.record_subject_kind NOT NULL,
  student_id uuid,
  parent_user_id uuid,
  subject_id uuid GENERATED ALWAYS AS (coalesce(student_id, parent_user_id)) STORED,
  field_id uuid NOT NULL,
  -- The field definition this answer was given under; updated on each write to the version then
  -- current, never by a publish.
  field_version_id uuid NOT NULL,
  -- Plaintext JSON for standard fields; NULL for sensitive fields and document fields.
  value jsonb,
  -- Sensitive fields only (ADR-019): nonce || ciphertext || tag, the keyring id that sealed it,
  -- and the mask every non-reveal response returns.
  value_ciphertext bytea,
  value_key_id text,
  value_mask text,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_record_answers_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_record_answers_subject_field UNIQUE (school_id, subject_kind, subject_id, field_id),
  CONSTRAINT fk_record_answers_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Cascade: an answer means nothing without the person it is about.
  CONSTRAINT fk_record_answers_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_record_answers_parent_user FOREIGN KEY (parent_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_record_answers_field FOREIGN KEY (field_id, school_id)
    REFERENCES app.record_fields (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_record_answers_field_version FOREIGN KEY (field_version_id, school_id)
    REFERENCES app.record_field_versions (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_record_answers_updated_by FOREIGN KEY (updated_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE SET NULL (updated_by),
  CONSTRAINT ck_record_answers_subject CHECK (
    (subject_kind = 'student' AND student_id IS NOT NULL AND parent_user_id IS NULL)
    OR (subject_kind = 'parent' AND parent_user_id IS NOT NULL AND student_id IS NULL)
  ),
  -- Exactly one storage form: plaintext, sealed (all three sealed columns together), or neither
  -- (a document answer, or a value the retention job has deleted).
  CONSTRAINT ck_record_answers_storage CHECK (
    (value_ciphertext IS NULL AND value_key_id IS NULL AND value_mask IS NULL)
    OR (
      value IS NULL AND value_ciphertext IS NOT NULL AND value_key_id IS NOT NULL
      AND value_mask IS NOT NULL
    )
  ),
  CONSTRAINT ck_record_answers_value_mask CHECK (value_mask IS NULL OR char_length(value_mask) <= 16),
  CONSTRAINT ck_record_answers_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX ix_record_answers_school_field ON app.record_answers (school_id, field_id);
CREATE INDEX ix_record_answers_school_student
  ON app.record_answers (school_id, student_id) WHERE student_id IS NOT NULL;
CREATE INDEX ix_record_answers_school_parent_user
  ON app.record_answers (school_id, parent_user_id) WHERE parent_user_id IS NOT NULL;
CREATE INDEX ix_record_answers_school_field_version
  ON app.record_answers (school_id, field_version_id);
CREATE INDEX ix_record_answers_school_updated_by
  ON app.record_answers (school_id, updated_by) WHERE updated_by IS NOT NULL;

REVOKE ALL PRIVILEGES ON TABLE app.record_answers FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.record_answers TO studafy_app;
SELECT app.apply_tenant_isolation('app', 'record_answers');

CREATE POLICY role_scope_visibility ON app.record_answers
  AS RESTRICTIVE
  FOR SELECT
  TO studafy_app
  USING (
    CASE subject_kind
      WHEN 'student' THEN app.can_read_student(student_id)
      ELSE app.current_user_is_school_admin()
    END
  );

-- 5 -------------------------------------------------------------------------------------------------

CREATE TABLE app.record_documents (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_record_documents PRIMARY KEY,
  school_id uuid NOT NULL,
  answer_id uuid NOT NULL,
  status app.record_document_status NOT NULL DEFAULT 'missing',
  storage_key text,
  original_file_name text,
  mime_type text,
  size_bytes bigint,
  -- Stored under the stricter record.sensitiveDocument content class (SSE-KMS, short-lived URLs).
  sensitive boolean NOT NULL DEFAULT false,
  uploaded_by uuid,
  uploaded_at timestamptz,
  verified_by uuid,
  verified_at timestamptz,
  expires_on date,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_record_documents_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_record_documents_answer UNIQUE (school_id, answer_id),
  CONSTRAINT uq_record_documents_storage_key UNIQUE (storage_key),
  CONSTRAINT fk_record_documents_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_record_documents_answer FOREIGN KEY (answer_id, school_id)
    REFERENCES app.record_answers (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_record_documents_uploaded_by FOREIGN KEY (uploaded_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE SET NULL (uploaded_by),
  CONSTRAINT fk_record_documents_verified_by FOREIGN KEY (verified_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE SET NULL (verified_by),
  CONSTRAINT ck_record_documents_storage_key CHECK (
    storage_key IS NULL OR (
      storage_key = btrim(storage_key)
      AND storage_key ~ ('^permanent/' || school_id::text || '/[^/]+/[^/]+$')
    )
  ),
  -- A file is present exactly when the status says one is.
  CONSTRAINT ck_record_documents_file CHECK (
    (status = 'missing' AND storage_key IS NULL AND original_file_name IS NULL
      AND mime_type IS NULL AND size_bytes IS NULL AND uploaded_at IS NULL)
    OR (status <> 'missing' AND storage_key IS NOT NULL AND original_file_name IS NOT NULL
      AND mime_type IS NOT NULL AND size_bytes IS NOT NULL AND uploaded_at IS NOT NULL)
  ),
  CONSTRAINT ck_record_documents_verified CHECK (
    (status = 'verified') = (verified_at IS NOT NULL)
  ),
  CONSTRAINT ck_record_documents_original_file_name CHECK (
    original_file_name IS NULL OR (
      original_file_name = btrim(original_file_name) AND original_file_name <> ''
      AND char_length(original_file_name) <= 255 AND original_file_name !~ '[/\\]'
    )
  ),
  -- Mirrors the record.document / record.sensitiveDocument content classes.
  CONSTRAINT ck_record_documents_mime_type CHECK (
    mime_type IS NULL OR mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/heic')
  ),
  CONSTRAINT ck_record_documents_size_bytes CHECK (size_bytes IS NULL OR size_bytes > 0),
  CONSTRAINT ck_record_documents_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX ix_record_documents_school_expires_on
  ON app.record_documents (school_id, expires_on) WHERE expires_on IS NOT NULL;
CREATE INDEX ix_record_documents_school_uploaded_by
  ON app.record_documents (school_id, uploaded_by) WHERE uploaded_by IS NOT NULL;
CREATE INDEX ix_record_documents_school_verified_by
  ON app.record_documents (school_id, verified_by) WHERE verified_by IS NOT NULL;

REVOKE ALL PRIVILEGES ON TABLE app.record_documents FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.record_documents TO studafy_app;
SELECT app.apply_tenant_isolation('app', 'record_documents');

-- A document is visible exactly when its answer is: the subquery runs under app.record_answers'
-- own role_scope_visibility policy, so no predicate is repeated here.
CREATE POLICY role_scope_visibility ON app.record_documents
  AS RESTRICTIVE
  FOR SELECT
  TO studafy_app
  USING (
    EXISTS (
      SELECT 1
      FROM app.record_answers AS answer
      WHERE answer.id = record_documents.answer_id
        AND answer.school_id = record_documents.school_id
    )
  );

-- 6 -------------------------------------------------------------------------------------------------

ALTER TABLE app.students ADD COLUMN left_at timestamptz;

-- Set when a student moves into a leaving status, cleared when they come back. Maintained by the
-- database so every path that changes status (the API, the import worker, ERPNext sync) keeps it.
CREATE FUNCTION app.set_student_left_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.status IN ('graduated', 'withdrawn', 'archived') THEN
    IF TG_OP = 'INSERT' OR OLD.status NOT IN ('graduated', 'withdrawn', 'archived') THEN
      NEW.left_at := coalesce(NEW.left_at, CURRENT_TIMESTAMP);
    END IF;
  ELSE
    NEW.left_at := NULL;
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION app.set_student_left_at() FROM PUBLIC;

CREATE TRIGGER trg_students_left_at
  BEFORE INSERT OR UPDATE OF status ON app.students
  FOR EACH ROW EXECUTE FUNCTION app.set_student_left_at();

-- Backfill students who had already left: the last update is the best record of when. Forced RLS
-- applies to the owner too, so this walks one tenant at a time (as 000114 does).
DO $backfill$
DECLARE
  tenant_id uuid;
BEGIN
  FOR tenant_id IN SELECT id FROM app.schools LOOP
    PERFORM pg_catalog.set_config('app.school_id', tenant_id::text, true);
    UPDATE app.students
       SET left_at = updated_at
     WHERE school_id = tenant_id
       AND status IN ('graduated', 'withdrawn', 'archived')
       AND left_at IS NULL;
  END LOOP;
END
$backfill$;

RESET ROLE;
