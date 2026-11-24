-- Ministry results export (docs/plans/academic-phase2.md, WS-L): a school's templates for sending
-- its finalized results to a ministry of education (or a platform such as Noor or eSIS) in the
-- columns, codes, file type and encoding that ministry asks for. Formats differ and change, so a
-- template is configuration the school edits, never a hard-coded format.
--
-- TEMPLATES. app.ministry_export_templates: a name, a free target label ("Jordan MoE"), CSV or XLSX,
-- UTF-8 with or without a byte-order mark (Excel needs one to read Arabic in a CSV), one row per
-- student per subject or one per student (their overall result), the decimals for marks and
-- percentages, and the student record field (000170) the national ID is read from. A national ID is
-- whatever the school collects in its records, often a sensitive field (ADR-019); the export reads
-- it with the records' own access rules and audit (apps/api/src/modules/ministry-export).
--
-- COLUMNS. app.ministry_export_columns: the file's columns in order, each with its heading and one
-- known field (packages/grading-engine, ministry-export.ts) or a fixed text, and
-- app.ministry_export_value_maps: an optional translation of a column's values ("pass" -> "1").
--
-- SUBJECT CODES. app.ministry_export_subject_codes: the ministry's code for each of the school's
-- subjects, per template (the `subject_ministry_code` field). A subject with none is reported as
-- unmapped when exporting.
--
-- Nothing per student is stored: an export reads finalized results (000160, current finalizations
-- only) when it runs, and each download is audited. A template is saved whole: its columns, value
-- maps and subject codes are replaced, and deleting it deletes them.
--
-- VISIBILITY. Configuration, not personal data: tenant isolation only. School leadership reads and
-- writes it (academicConfig:manage / result:finalize, checked by the API).
--
-- Depends on 000006 (tenant helpers), 000009 (subjects), 000170 (record fields).

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Templates
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.ministry_export_templates (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ministry_export_templates PRIMARY KEY,
  school_id uuid NOT NULL,
  name text NOT NULL,
  -- Who the file is for, free text ("Jordan MoE", "Noor", "eSIS"); '' when not given.
  target text NOT NULL DEFAULT '',
  file_format text NOT NULL DEFAULT 'csv',
  encoding text NOT NULL DEFAULT 'utf8_bom',
  row_kind text NOT NULL DEFAULT 'subject',
  decimal_places smallint NOT NULL DEFAULT 2,
  -- The student record field holding the national ID; NULL until the school picks one.
  national_id_field_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_ministry_export_templates_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_ministry_export_templates_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- A record field is archived, never deleted (000170).
  CONSTRAINT fk_ministry_export_templates_national_id_field
    FOREIGN KEY (national_id_field_id, school_id)
    REFERENCES app.record_fields (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_ministry_export_templates_name CHECK (
    name = btrim(name) AND name <> '' AND char_length(name) <= 120
  ),
  CONSTRAINT ck_ministry_export_templates_target CHECK (
    target = btrim(target) AND char_length(target) <= 120
  ),
  CONSTRAINT ck_ministry_export_templates_file_format CHECK (file_format IN ('csv', 'xlsx')),
  CONSTRAINT ck_ministry_export_templates_encoding CHECK (encoding IN ('utf8', 'utf8_bom')),
  CONSTRAINT ck_ministry_export_templates_row_kind CHECK (row_kind IN ('subject', 'overall')),
  CONSTRAINT ck_ministry_export_templates_decimal_places CHECK (decimal_places BETWEEN 0 AND 3),
  CONSTRAINT ck_ministry_export_templates_timestamps CHECK (updated_at >= created_at)
);

-- Names are unique within a school, whatever their case.
CREATE UNIQUE INDEX uq_ministry_export_templates_school_name
  ON app.ministry_export_templates (school_id, lower(name));
-- The templates as listed (by name); also the plain school_id-leading index the RLS path needs.
CREATE INDEX idx_ministry_export_templates_school_name
  ON app.ministry_export_templates (school_id, name);
CREATE INDEX idx_ministry_export_templates_national_id_field_fk
  ON app.ministry_export_templates (national_id_field_id, school_id)
  WHERE national_id_field_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------
-- 2. Columns and their value maps
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.ministry_export_columns (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ministry_export_columns PRIMARY KEY,
  school_id uuid NOT NULL,
  template_id uuid NOT NULL,
  position smallint NOT NULL,
  header text NOT NULL,
  field text NOT NULL,
  -- The text every row gets; `constant` columns only.
  constant_value text,
  CONSTRAINT uq_ministry_export_columns_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_ministry_export_columns_template_position UNIQUE (school_id, template_id, position),
  CONSTRAINT fk_ministry_export_columns_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Deleting a template deletes its columns with it.
  CONSTRAINT fk_ministry_export_columns_template FOREIGN KEY (template_id, school_id)
    REFERENCES app.ministry_export_templates (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_ministry_export_columns_position CHECK (position BETWEEN 0 AND 59),
  CONSTRAINT ck_ministry_export_columns_header CHECK (
    header = btrim(header) AND header <> '' AND char_length(header) <= 120
  ),
  -- The fields of packages/grading-engine MINISTRY_EXPORT_FIELDS. Arabic names (WS-K) are added
  -- here by a later migration when students and subjects carry them.
  CONSTRAINT ck_ministry_export_columns_field CHECK (field IN (
    'national_id', 'admission_number', 'first_name', 'middle_name', 'last_name', 'full_name',
    'date_of_birth', 'grade_level', 'section', 'academic_year', 'term', 'subject_code',
    'subject_name', 'subject_ministry_code', 'mark', 'max_mark', 'percentage', 'grade_label', 'gpa',
    'status', 'constant'
  )),
  CONSTRAINT ck_ministry_export_columns_constant CHECK (
    CASE
      WHEN field = 'constant' THEN
        constant_value IS NOT NULL AND constant_value = btrim(constant_value)
        AND constant_value <> '' AND char_length(constant_value) <= 200
      ELSE constant_value IS NULL
    END
  )
);

CREATE INDEX idx_ministry_export_columns_template_fk
  ON app.ministry_export_columns (template_id, school_id);

CREATE TABLE app.ministry_export_value_maps (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ministry_export_value_maps PRIMARY KEY,
  school_id uuid NOT NULL,
  column_id uuid NOT NULL,
  position smallint NOT NULL,
  from_value text NOT NULL,
  -- '' writes an empty cell.
  to_value text NOT NULL,
  CONSTRAINT uq_ministry_export_value_maps_column_from UNIQUE (school_id, column_id, from_value),
  CONSTRAINT fk_ministry_export_value_maps_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Deleting a column (or its template) deletes its value map with it.
  CONSTRAINT fk_ministry_export_value_maps_column FOREIGN KEY (column_id, school_id)
    REFERENCES app.ministry_export_columns (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_ministry_export_value_maps_position CHECK (position BETWEEN 0 AND 199),
  CONSTRAINT ck_ministry_export_value_maps_from CHECK (
    from_value = btrim(from_value) AND from_value <> '' AND char_length(from_value) <= 200
  ),
  CONSTRAINT ck_ministry_export_value_maps_to CHECK (
    to_value = btrim(to_value) AND char_length(to_value) <= 200
  )
);

CREATE INDEX idx_ministry_export_value_maps_column_fk
  ON app.ministry_export_value_maps (column_id, school_id);

-- ---------------------------------------------------------------------------------------------------
-- 3. The ministry's subject codes
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.ministry_export_subject_codes (
  school_id uuid NOT NULL,
  template_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  code text NOT NULL,
  CONSTRAINT pk_ministry_export_subject_codes PRIMARY KEY (school_id, template_id, subject_id),
  CONSTRAINT fk_ministry_export_subject_codes_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Deleting a template deletes its subject codes with it.
  CONSTRAINT fk_ministry_export_subject_codes_template FOREIGN KEY (template_id, school_id)
    REFERENCES app.ministry_export_templates (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_ministry_export_subject_codes_subject FOREIGN KEY (subject_id, school_id)
    REFERENCES app.subjects (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_ministry_export_subject_codes_code CHECK (
    code = btrim(code) AND code <> '' AND char_length(code) <= 60
  )
);

-- The primary key's (school_id, template_id, ...) prefix does not serve the (template_id, school_id)
-- and (subject_id, school_id) foreign keys.
CREATE INDEX idx_ministry_export_subject_codes_template_fk
  ON app.ministry_export_subject_codes (template_id, school_id);
CREATE INDEX idx_ministry_export_subject_codes_subject_fk
  ON app.ministry_export_subject_codes (subject_id, school_id);

COMMENT ON TABLE app.ministry_export_templates IS
  'A school''s ministry results export template: target, file type, encoding, row kind and the national ID''s record field (000264).';
COMMENT ON TABLE app.ministry_export_columns IS
  'A ministry export template''s columns in order, each a known field or a fixed text (000264); deleted with the template.';
COMMENT ON TABLE app.ministry_export_value_maps IS
  'A ministry export column''s value translations, ours -> the ministry''s (000264); deleted with the column.';
COMMENT ON TABLE app.ministry_export_subject_codes IS
  'The ministry''s code for a school subject in one export template (000264); deleted with the template.';
COMMENT ON COLUMN app.ministry_export_templates.national_id_field_id IS
  'The student record field the national ID is read from; a sensitive one is opened only for a download by leadership holding studentRecord:readSensitive, and audited (000264, ADR-019).';

-- ---------------------------------------------------------------------------------------------------
-- 4. Grants and RLS
-- ---------------------------------------------------------------------------------------------------

-- 000002's default privileges grant studafy_app full DML on new tables; take it back from it and
-- PUBLIC, then grant exactly what the API needs. A template is saved whole: its columns, value maps
-- and subject codes are replaced, and a template can be deleted, so all four are deleted from.
REVOKE ALL PRIVILEGES ON TABLE
  app.ministry_export_templates, app.ministry_export_columns, app.ministry_export_value_maps,
  app.ministry_export_subject_codes
FROM PUBLIC, studafy_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  app.ministry_export_templates, app.ministry_export_columns, app.ministry_export_value_maps,
  app.ministry_export_subject_codes
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'ministry_export_templates');
SELECT app.apply_tenant_isolation('app', 'ministry_export_columns');
SELECT app.apply_tenant_isolation('app', 'ministry_export_value_maps');
SELECT app.apply_tenant_isolation('app', 'ministry_export_subject_codes');

RESET ROLE;
