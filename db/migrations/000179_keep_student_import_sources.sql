-- Nothing in a school's import file is lost (docs/modules/student-import-mapping-guide.md
-- "Import history and unmapped columns").
--
-- 1. app.student_imports gains the original uploaded file: its object storage key (under the
--    import.source content class, promoted under the sensitive-documents KMS key), name, size and
--    upload time. Removing the file (by staff, the retention sweep or a tenant-closure erasure)
--    clears the key and size and records when and why; the name and upload time stay as history.
--
-- 2. app.student_import_rows gains the person each line was applied to. A completed import keeps
--    only the cells of columns that were not mapped, and only on lines whose student this import
--    created or updated (student_id) or whose parent it created (parent_user_id), so a column can
--    be mapped to a record field later without a re-upload. People are never matched by any value
--    in the file: these ids are the ones the import itself wrote.
--
-- 3. app.student_import_unmapped_columns -- each import's unmapped source columns, one row each,
--    with what staff later applied the column to. Header text only, never a cell. The normalized
--    header also feeds the platform-wide "which columns do schools bring that we do not map" count.
--
-- 4. app.student_import_settings -- how long a school keeps original files and leftover cells.
--    No row means the default (180 days); a school may only shorten it.

SET ROLE studafy_admin;

-- Validating a new foreign key scans the referencing table, and forced RLS applies that scan's
-- tenant_isolation predicate even to the owner (see 000114). The new columns are NULL on every
-- existing row, so the nil tenant's empty scan is exact.
SELECT pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

-- 1 -------------------------------------------------------------------------------------------------

ALTER TABLE app.student_imports
  ADD COLUMN source_storage_key text,
  ADD COLUMN source_file_name text,
  ADD COLUMN source_size_bytes bigint,
  ADD COLUMN source_uploaded_at timestamptz,
  ADD COLUMN source_removed_at timestamptz,
  ADD COLUMN source_removed_reason text,
  -- When the retention sweep or an erasure deleted the leftover cells of a completed import.
  ADD COLUMN cells_purged_at timestamptz,
  -- A stored file always has its name, size and upload time.
  ADD CONSTRAINT ck_student_imports_source_file CHECK (
    source_storage_key IS NULL
    OR (source_file_name IS NOT NULL AND source_size_bytes IS NOT NULL
        AND source_uploaded_at IS NOT NULL)
  ),
  -- Name and upload time are kept together, as history, once the file is gone.
  ADD CONSTRAINT ck_student_imports_source_history CHECK (
    (source_file_name IS NULL) = (source_uploaded_at IS NULL)
  ),
  -- Pins a stored key to its own school's permanent/ prefix (as 000047 does for attachments).
  ADD CONSTRAINT ck_student_imports_source_storage_key CHECK (
    source_storage_key IS NULL
    OR source_storage_key LIKE 'permanent/' || school_id::text || '/%'
  ),
  ADD CONSTRAINT ck_student_imports_source_file_name CHECK (
    source_file_name IS NULL OR char_length(source_file_name) BETWEEN 1 AND 255
  ),
  ADD CONSTRAINT ck_student_imports_source_size CHECK (
    source_size_bytes IS NULL OR source_size_bytes > 0
  ),
  ADD CONSTRAINT ck_student_imports_source_removed CHECK (
    (source_removed_at IS NULL) = (source_removed_reason IS NULL)
    AND (source_removed_reason IS NULL OR source_removed_reason IN ('deleted', 'retention', 'erasure'))
    AND (source_removed_at IS NULL OR (source_storage_key IS NULL AND source_uploaded_at IS NOT NULL))
  );

-- The retention sweep's scan: files still held, oldest first.
CREATE INDEX ix_student_imports_source_held
  ON app.student_imports (school_id, source_uploaded_at)
  WHERE source_storage_key IS NOT NULL;

-- 2 -------------------------------------------------------------------------------------------------

ALTER TABLE app.student_import_rows
  ADD COLUMN student_id uuid,
  ADD COLUMN parent_user_id uuid,
  -- Cascade: a leftover cell exists only to be applied to this person's record.
  ADD CONSTRAINT fk_student_import_rows_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT fk_student_import_rows_parent FOREIGN KEY (parent_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  -- A line carries a parent only alongside the student it was imported with.
  ADD CONSTRAINT ck_student_import_rows_parent CHECK (parent_user_id IS NULL OR student_id IS NOT NULL);

-- Per-person erasure deletes a person's leftover cells by these.
CREATE INDEX ix_student_import_rows_student
  ON app.student_import_rows (school_id, student_id)
  WHERE student_id IS NOT NULL;
CREATE INDEX ix_student_import_rows_parent
  ON app.student_import_rows (school_id, parent_user_id)
  WHERE parent_user_id IS NOT NULL;

-- 3 -------------------------------------------------------------------------------------------------

CREATE TABLE app.student_import_unmapped_columns (
  school_id uuid NOT NULL,
  import_id uuid NOT NULL,
  -- 0-based index of the column in app.student_imports.source_headers.
  position int NOT NULL,
  header text NOT NULL,
  -- packages/student-import's normalizeHeader: "Blood Type" and "blood_type" compare equal.
  normalized_header text NOT NULL,
  -- What staff last applied the column to, once they have.
  applied_field_id uuid,
  applied_subject_kind app.record_subject_kind,
  applied_count int,
  applied_by uuid,
  applied_at timestamptz,
  CONSTRAINT pk_student_import_unmapped_columns PRIMARY KEY (school_id, import_id, position),
  CONSTRAINT fk_student_import_unmapped_columns_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Cascade: as for staging rows, the abandoned-import sweep deletes the import row only.
  CONSTRAINT fk_student_import_unmapped_columns_import FOREIGN KEY (import_id, school_id)
    REFERENCES app.student_imports (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_student_import_unmapped_columns_field FOREIGN KEY (applied_field_id, school_id)
    REFERENCES app.record_fields (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_import_unmapped_columns_applied_by FOREIGN KEY (applied_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_student_import_unmapped_columns_position CHECK (position >= 0),
  CONSTRAINT ck_student_import_unmapped_columns_header CHECK (
    char_length(header) BETWEEN 1 AND 500 AND char_length(normalized_header) <= 500
  ),
  CONSTRAINT ck_student_import_unmapped_columns_applied CHECK (
    (applied_field_id IS NULL) = (applied_subject_kind IS NULL)
    AND (applied_field_id IS NULL) = (applied_count IS NULL)
    AND (applied_field_id IS NULL) = (applied_by IS NULL)
    AND (applied_field_id IS NULL) = (applied_at IS NULL)
    AND (applied_count IS NULL OR applied_count >= 0)
  )
);

REVOKE ALL PRIVILEGES ON TABLE app.student_import_unmapped_columns FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.student_import_unmapped_columns TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'student_import_unmapped_columns');

-- 4 -------------------------------------------------------------------------------------------------

CREATE TABLE app.student_import_settings (
  school_id uuid CONSTRAINT pk_student_import_settings PRIMARY KEY,
  source_retention_days int NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_student_import_settings_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_student_import_settings_updated_by FOREIGN KEY (updated_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- 180 days is the ceiling as well as the default: a school can shorten it, never extend it.
  CONSTRAINT ck_student_import_settings_retention CHECK (source_retention_days BETWEEN 1 AND 180),
  CONSTRAINT ck_student_import_settings_timestamps CHECK (updated_at >= created_at)
);

REVOKE ALL PRIVILEGES ON TABLE app.student_import_settings FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE app.student_import_settings TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'student_import_settings');

RESET ROLE;
