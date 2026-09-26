-- Student CSV column mapping and staging (ST-299).
--
-- 1. app.student_import_mappings -- a school's saved column mappings. Each maps Studafy's import
--    fields (admission_number, email, ...) to the header text of a school's own CSV export, so a file
--    with reordered or renamed columns imports without being rewritten into the template first.
--    The field set is closed and validated by the application (packages/student-import), so the map
--    is stored as one jsonb object rather than a child table of (field, header) rows.
--
-- 2. app.student_imports gains the mapping snapshot it was staged with, the detected header row, and
--    who confirmed it. The snapshot is a copy, not a foreign key: editing or deleting a saved mapping
--    must never change what an already-staged import means.
--
-- 3. app.student_import_rows -- the staging table. One row per CSV data line: the raw cells keyed by
--    source header, and the mapped + validated record (NULL when the line failed validation). The
--    worker migrates these into students/users/parent_child_links in one transaction. They replace
--    app.student_imports.rows_data, which held only the valid records and so could not be re-mapped.
--    Existing rows_data is backfilled below and the column dropped.

SET ROLE studafy_admin;

-- 1 -------------------------------------------------------------------------------------------------

CREATE TABLE app.student_import_mappings (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_student_import_mappings PRIMARY KEY,
  school_id uuid NOT NULL,
  name text NOT NULL,
  normalized_name text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
  column_mapping jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_student_import_mappings_school_name UNIQUE (school_id, normalized_name),
  CONSTRAINT fk_student_import_mappings_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_import_mappings_created_by FOREIGN KEY (created_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_import_mappings_name CHECK (
    name = btrim(name) AND name <> '' AND char_length(name) <= 100
  ),
  CONSTRAINT ck_student_import_mappings_column_mapping CHECK (
    jsonb_typeof(column_mapping) = 'object'
  ),
  CONSTRAINT ck_student_import_mappings_timestamps CHECK (updated_at >= created_at)
);

REVOKE ALL PRIVILEGES ON TABLE app.student_import_mappings FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.student_import_mappings TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'student_import_mappings');

-- 2 -------------------------------------------------------------------------------------------------

-- Validating a new foreign key scans the referencing table, and forced RLS applies that scan's
-- tenant_isolation predicate even to the owner, which fails outright while app.school_id is unset.
-- Arming the nil tenant makes the scan see no rows. That is exact, not a shortcut: confirmed_by is
-- added in this same statement, so every existing row holds NULL and none can violate the key.
SELECT pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

ALTER TABLE app.student_imports
  ADD COLUMN header_line int NOT NULL DEFAULT 1,
  ADD COLUMN source_headers jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN column_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN confirmed_by uuid,
  ADD CONSTRAINT uq_student_imports_id_school UNIQUE (id, school_id),
  ADD CONSTRAINT fk_student_imports_confirmed_by FOREIGN KEY (confirmed_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT ck_student_imports_header_line CHECK (header_line >= 1),
  ADD CONSTRAINT ck_student_imports_source_headers CHECK (jsonb_typeof(source_headers) = 'array'),
  ADD CONSTRAINT ck_student_imports_column_mapping CHECK (jsonb_typeof(column_mapping) = 'object');

-- 3 -------------------------------------------------------------------------------------------------

CREATE TABLE app.student_import_rows (
  school_id uuid NOT NULL,
  import_id uuid NOT NULL,
  -- 1-based line in the uploaded file, so an admin can find the row in their own spreadsheet.
  line_number int NOT NULL,
  -- Raw cells keyed by the file's own header text. Kept so a new mapping can be applied without a
  -- re-upload.
  source jsonb NOT NULL,
  -- The mapped, validated record the worker migrates. NULL when the line failed validation; the
  -- line's errors are on app.student_imports.errors with the same line number.
  record jsonb,
  CONSTRAINT pk_student_import_rows PRIMARY KEY (school_id, import_id, line_number),
  CONSTRAINT fk_student_import_rows_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Cascade: staging rows have no meaning without their import, and the abandoned-import sweep
  -- deletes the import row only.
  CONSTRAINT fk_student_import_rows_import FOREIGN KEY (import_id, school_id)
    REFERENCES app.student_imports (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_student_import_rows_line_number CHECK (line_number >= 1),
  CONSTRAINT ck_student_import_rows_source CHECK (jsonb_typeof(source) = 'object'),
  CONSTRAINT ck_student_import_rows_record CHECK (record IS NULL OR jsonb_typeof(record) = 'object')
);

REVOKE ALL PRIVILEGES ON TABLE app.student_import_rows FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.student_import_rows TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'student_import_rows');

-- Backfill ------------------------------------------------------------------------------------------
--
-- rows_data held only the rows that passed validation, keyed by the template's field names, so the
-- field names are also the source headers and the mapping is the identity. Original line numbers
-- were not recorded; positions are used instead, which is the only lossless choice available.
-- Forced RLS applies to the owner too, so this walks one tenant at a time (as 000072 does).

DO $backfill$
DECLARE
  tenant_id uuid;
  template_fields text[] := ARRAY[
    'admission_number', 'email', 'first_name', 'middle_name', 'last_name', 'preferred_name',
    'date_of_birth', 'status', 'parent_email', 'parent_relationship'
  ];
BEGIN
  FOR tenant_id IN SELECT id FROM app.schools LOOP
    PERFORM pg_catalog.set_config('app.school_id', tenant_id::text, true);

    INSERT INTO app.student_import_rows (school_id, import_id, line_number, source, record)
    SELECT si.school_id, si.id, (element.ordinality + 1)::int, element.value, element.value
    FROM app.student_imports AS si
    CROSS JOIN LATERAL jsonb_array_elements(si.rows_data) WITH ORDINALITY AS element(value, ordinality)
    WHERE si.school_id = tenant_id
      AND jsonb_typeof(element.value) = 'object';

    UPDATE app.student_imports AS si
    SET source_headers = to_jsonb(template_fields),
        column_mapping = (
          SELECT jsonb_object_agg(field, field) FROM unnest(template_fields) AS field
        )
    WHERE si.school_id = tenant_id;
  END LOOP;

  PERFORM pg_catalog.set_config(
    'app.school_id',
    '00000000-0000-0000-0000-000000000000',
    true
  );
END
$backfill$;

ALTER TABLE app.student_imports DROP COLUMN rows_data;

RESET ROLE;
