-- Custom lists (docs/modules/custom-lists.md).
--
-- A school keeps data Studafy has no section for -- bus routes, library loans, clinic visits,
-- lockers, uniform orders, alumni -- as its own table: typed columns, and rows that may point to a
-- student, a parent, a member of staff or a class.
--
-- 1. app.custom_lists                -- the list: a name in English and Arabic, a description, who
--    may use it (audience) and which kinds of link its rows may carry (four booleans, not an
--    array: the RLS coverage check rejects flexible columns).
-- 2. app.custom_list_columns         -- typed columns reusing the record field types (every type but
--    document: a list stores no files) and sensitivities (000170).
--    app.custom_list_column_options  -- the choices of a single_choice / multi_choice column, one row
--    each, instead of record_fields' jsonb options.
-- 3. app.custom_list_rows            -- one per entry, with at most one link: student_id, user_id (a
--    parent or a member of staff, told apart by link_kind; the application checks the role, as it
--    does for record answers) or class_id. Links cascade: a row about a person goes with them.
-- 4. app.custom_list_values          -- one row per filled cell, in the typed column its column's
--    type uses: value_text (short_text, long_text, phone, email), value_number, value_date,
--    value_bool (yes_no) or option_id (a choice -- one row per chosen option for multi_choice). A
--    sensitive cell is only AES-256-GCM ciphertext plus its mask (ADR-019), sealed with the row and
--    column as additional authenticated data; no plaintext column is set.
--
-- Caps (50 lists, 30 columns per list, 5,000 rows per list, 20,000 rows per school) are enforced by
-- the API, which serializes writes per school with an advisory lock and reads the school's totals
-- through app.custom_list_usage (5).
--
-- ROW SCOPE. Tenant isolation on every table. A RESTRICTIVE SELECT role_scope_visibility policy on
-- app.custom_lists admits only the list's audience (app.can_read_custom_list): admins = ORG_ADMIN;
-- leadership = ORG_ADMIN and PRINCIPAL; staff = every school staff role. The other four tables admit
-- a row exactly when its list is visible -- the subquery runs under app.custom_lists' own policy, so
-- no predicate is repeated. Parents and students hold none of these roles and never see a list.
-- SELECT only, as in 000037: writes stay with tenant_isolation's WITH CHECK plus the permission
-- matrix and the API's audience check.
--
-- Nothing is matched or linked on a value: the link columns are set by staff choosing the person or
-- class, or by an import matching a school-issued key (member ID, admission number, employee number,
-- class code) exactly, shown in a preview before anything is written.

SET ROLE studafy_admin;

CREATE TYPE app.custom_list_audience AS ENUM ('admins', 'leadership', 'staff');
CREATE TYPE app.custom_list_link_kind AS ENUM ('student', 'parent', 'staff', 'class');

-- Whether the current user is in a list's audience. SECURITY DEFINER over app.user_roles, as
-- app.current_user_is_school_admin (000037, 000120) is; SUPER_ADMIN counts as ORG_ADMIN there too.
CREATE FUNCTION app.can_read_custom_list(target app.custom_list_audience)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.user_roles AS ur
    WHERE ur.school_id = current_setting('app.school_id')::uuid
      AND ur.user_id = app.scope_user_id()
      AND ur.role::text = ANY (
        CASE target
          WHEN 'admins' THEN ARRAY['ORG_ADMIN', 'SUPER_ADMIN']
          WHEN 'leadership' THEN ARRAY['ORG_ADMIN', 'SUPER_ADMIN', 'PRINCIPAL']
          ELSE ARRAY[
            'ORG_ADMIN', 'SUPER_ADMIN', 'PRINCIPAL', 'ATTENDANCE_OFFICER', 'FINANCE', 'INSTRUCTOR'
          ]
        END
      )
  )
$function$;

REVOKE ALL ON FUNCTION app.can_read_custom_list(app.custom_list_audience) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_read_custom_list(app.custom_list_audience) TO studafy_app;

-- 1 -------------------------------------------------------------------------------------------------

CREATE TABLE app.custom_lists (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_custom_lists PRIMARY KEY,
  school_id uuid NOT NULL,
  name_en text NOT NULL,
  name_ar text NOT NULL,
  description text,
  audience app.custom_list_audience NOT NULL DEFAULT 'admins',
  link_student boolean NOT NULL DEFAULT false,
  link_parent boolean NOT NULL DEFAULT false,
  link_staff boolean NOT NULL DEFAULT false,
  link_class boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Global search (000171): the list's two names only -- never its description, which may name a
  -- child, and never a row value.
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', app.search_document(name_en || ' ' || name_ar))
  ) STORED,
  CONSTRAINT uq_custom_lists_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_custom_lists_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_custom_lists_created_by FOREIGN KEY (created_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE SET NULL (created_by),
  CONSTRAINT ck_custom_lists_name_en CHECK (
    name_en = btrim(name_en) AND name_en <> '' AND char_length(name_en) <= 120
  ),
  CONSTRAINT ck_custom_lists_name_ar CHECK (
    name_ar = btrim(name_ar) AND name_ar <> '' AND char_length(name_ar) <= 120
  ),
  CONSTRAINT ck_custom_lists_description CHECK (
    description IS NULL OR (description = btrim(description) AND description <> ''
      AND char_length(description) <= 1000)
  ),
  CONSTRAINT ck_custom_lists_timestamps CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX uq_custom_lists_school_name_en ON app.custom_lists (school_id, lower(name_en));
CREATE INDEX ix_custom_lists_school_created_by
  ON app.custom_lists (school_id, created_by) WHERE created_by IS NOT NULL;

REVOKE ALL PRIVILEGES ON TABLE app.custom_lists FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.custom_lists TO studafy_app;
SELECT app.apply_tenant_isolation('app', 'custom_lists');

CREATE POLICY role_scope_visibility ON app.custom_lists
  AS RESTRICTIVE
  FOR SELECT
  TO studafy_app
  USING (app.can_read_custom_list(audience));

-- 2 -------------------------------------------------------------------------------------------------

CREATE TABLE app.custom_list_columns (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_custom_list_columns PRIMARY KEY,
  school_id uuid NOT NULL,
  list_id uuid NOT NULL,
  field_type app.record_field_type NOT NULL,
  label_en text NOT NULL,
  label_ar text NOT NULL,
  required boolean NOT NULL DEFAULT false,
  sensitivity app.record_field_sensitivity NOT NULL DEFAULT 'standard',
  sort_order int NOT NULL DEFAULT 0,
  -- Archiving hides a column and keeps its values; only deleting the list or the row removes them.
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_custom_list_columns_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_custom_list_columns_id_list_school UNIQUE (id, list_id, school_id),
  CONSTRAINT fk_custom_list_columns_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_custom_list_columns_list FOREIGN KEY (list_id, school_id)
    REFERENCES app.custom_lists (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_custom_list_columns_created_by FOREIGN KEY (created_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE SET NULL (created_by),
  CONSTRAINT ck_custom_list_columns_field_type CHECK (field_type <> 'document'),
  CONSTRAINT ck_custom_list_columns_label_en CHECK (
    label_en = btrim(label_en) AND label_en <> '' AND char_length(label_en) <= 200
  ),
  CONSTRAINT ck_custom_list_columns_label_ar CHECK (
    label_ar = btrim(label_ar) AND label_ar <> '' AND char_length(label_ar) <= 200
  ),
  CONSTRAINT ck_custom_list_columns_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX ix_custom_list_columns_school_list_sort
  ON app.custom_list_columns (school_id, list_id, sort_order);
CREATE INDEX ix_custom_list_columns_school_created_by
  ON app.custom_list_columns (school_id, created_by) WHERE created_by IS NOT NULL;

REVOKE ALL PRIVILEGES ON TABLE app.custom_list_columns FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.custom_list_columns TO studafy_app;
SELECT app.apply_tenant_isolation('app', 'custom_list_columns');

CREATE POLICY role_scope_visibility ON app.custom_list_columns
  AS RESTRICTIVE
  FOR SELECT
  TO studafy_app
  USING (
    EXISTS (
      SELECT 1
      FROM app.custom_lists AS list
      WHERE list.id = custom_list_columns.list_id AND list.school_id = custom_list_columns.school_id
    )
  );

CREATE TABLE app.custom_list_column_options (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_custom_list_column_options PRIMARY KEY,
  school_id uuid NOT NULL,
  list_id uuid NOT NULL,
  column_id uuid NOT NULL,
  value text NOT NULL,
  label_en text NOT NULL,
  label_ar text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  CONSTRAINT uq_custom_list_column_options_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_custom_list_column_options_id_column_school UNIQUE (id, column_id, school_id),
  CONSTRAINT uq_custom_list_column_options_column_value UNIQUE (school_id, column_id, value),
  CONSTRAINT fk_custom_list_column_options_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_custom_list_column_options_column FOREIGN KEY (column_id, list_id, school_id)
    REFERENCES app.custom_list_columns (id, list_id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_custom_list_column_options_value CHECK (
    value = btrim(value) AND value <> '' AND char_length(value) <= 100
  ),
  CONSTRAINT ck_custom_list_column_options_labels CHECK (
    label_en = btrim(label_en) AND label_en <> '' AND char_length(label_en) <= 200
    AND label_ar = btrim(label_ar) AND label_ar <> '' AND char_length(label_ar) <= 200
  )
);

CREATE INDEX ix_custom_list_column_options_school_list_column
  ON app.custom_list_column_options (school_id, list_id, column_id);

REVOKE ALL PRIVILEGES ON TABLE app.custom_list_column_options FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.custom_list_column_options TO studafy_app;
SELECT app.apply_tenant_isolation('app', 'custom_list_column_options');

CREATE POLICY role_scope_visibility ON app.custom_list_column_options
  AS RESTRICTIVE
  FOR SELECT
  TO studafy_app
  USING (
    EXISTS (
      SELECT 1
      FROM app.custom_lists AS list
      WHERE list.id = custom_list_column_options.list_id
        AND list.school_id = custom_list_column_options.school_id
    )
  );

-- 3 -------------------------------------------------------------------------------------------------

CREATE TABLE app.custom_list_rows (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_custom_list_rows PRIMARY KEY,
  school_id uuid NOT NULL,
  list_id uuid NOT NULL,
  link_kind app.custom_list_link_kind,
  student_id uuid,
  user_id uuid,
  class_id uuid,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_custom_list_rows_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_custom_list_rows_id_list_school UNIQUE (id, list_id, school_id),
  CONSTRAINT fk_custom_list_rows_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_custom_list_rows_list FOREIGN KEY (list_id, school_id)
    REFERENCES app.custom_lists (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  -- Cascade: a row about a person or class goes with them, as a record answer does.
  CONSTRAINT fk_custom_list_rows_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_custom_list_rows_user FOREIGN KEY (user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_custom_list_rows_class FOREIGN KEY (class_id, school_id)
    REFERENCES app.classes (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_custom_list_rows_created_by FOREIGN KEY (created_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE SET NULL (created_by),
  CONSTRAINT fk_custom_list_rows_updated_by FOREIGN KEY (updated_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE SET NULL (updated_by),
  -- At most one link, and exactly the kind's own column.
  CONSTRAINT ck_custom_list_rows_link CHECK (
    CASE link_kind
      WHEN 'student' THEN student_id IS NOT NULL AND user_id IS NULL AND class_id IS NULL
      WHEN 'parent' THEN user_id IS NOT NULL AND student_id IS NULL AND class_id IS NULL
      WHEN 'staff' THEN user_id IS NOT NULL AND student_id IS NULL AND class_id IS NULL
      WHEN 'class' THEN class_id IS NOT NULL AND student_id IS NULL AND user_id IS NULL
      ELSE num_nonnulls(student_id, user_id, class_id) = 0
    END
  ),
  CONSTRAINT ck_custom_list_rows_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX ix_custom_list_rows_school_list_created
  ON app.custom_list_rows (school_id, list_id, created_at);
CREATE INDEX ix_custom_list_rows_school_student
  ON app.custom_list_rows (school_id, student_id) WHERE student_id IS NOT NULL;
CREATE INDEX ix_custom_list_rows_school_user
  ON app.custom_list_rows (school_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX ix_custom_list_rows_school_class
  ON app.custom_list_rows (school_id, class_id) WHERE class_id IS NOT NULL;
CREATE INDEX ix_custom_list_rows_school_created_by
  ON app.custom_list_rows (school_id, created_by) WHERE created_by IS NOT NULL;
CREATE INDEX ix_custom_list_rows_school_updated_by
  ON app.custom_list_rows (school_id, updated_by) WHERE updated_by IS NOT NULL;

REVOKE ALL PRIVILEGES ON TABLE app.custom_list_rows FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.custom_list_rows TO studafy_app;
SELECT app.apply_tenant_isolation('app', 'custom_list_rows');

CREATE POLICY role_scope_visibility ON app.custom_list_rows
  AS RESTRICTIVE
  FOR SELECT
  TO studafy_app
  USING (
    EXISTS (
      SELECT 1
      FROM app.custom_lists AS list
      WHERE list.id = custom_list_rows.list_id AND list.school_id = custom_list_rows.school_id
    )
  );

-- 4 -------------------------------------------------------------------------------------------------

CREATE TABLE app.custom_list_values (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_custom_list_values PRIMARY KEY,
  school_id uuid NOT NULL,
  list_id uuid NOT NULL,
  row_id uuid NOT NULL,
  column_id uuid NOT NULL,
  value_text text,
  value_number numeric,
  value_date date,
  value_bool boolean,
  option_id uuid,
  -- Sensitive columns only (ADR-019): version || nonce || ciphertext || tag, the keyring id that
  -- sealed it, and the mask every non-reveal response returns.
  value_ciphertext bytea,
  value_key_id text,
  value_mask text,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_custom_list_values_id_school UNIQUE (id, school_id),
  -- One value per cell; a multi_choice cell holds one row per chosen option.
  CONSTRAINT uq_custom_list_values_cell
    UNIQUE NULLS NOT DISTINCT (school_id, row_id, column_id, option_id),
  CONSTRAINT fk_custom_list_values_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- The row and the column belong to the same list.
  CONSTRAINT fk_custom_list_values_row FOREIGN KEY (row_id, list_id, school_id)
    REFERENCES app.custom_list_rows (id, list_id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_custom_list_values_column FOREIGN KEY (column_id, list_id, school_id)
    REFERENCES app.custom_list_columns (id, list_id, school_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  -- The option belongs to the value's column. NO ACTION, checked at the end of the statement, so a
  -- column deleted with its list takes its options and their values in one cascade.
  CONSTRAINT fk_custom_list_values_option FOREIGN KEY (option_id, column_id, school_id)
    REFERENCES app.custom_list_column_options (id, column_id, school_id)
    ON UPDATE RESTRICT ON DELETE NO ACTION,
  CONSTRAINT fk_custom_list_values_updated_by FOREIGN KEY (updated_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE SET NULL (updated_by),
  -- Exactly one storage form; the three sealed columns go together.
  CONSTRAINT ck_custom_list_values_storage CHECK (
    num_nonnulls(value_text, value_number, value_date, value_bool, option_id, value_ciphertext) = 1
    AND (value_ciphertext IS NULL) = (value_key_id IS NULL)
    AND (value_ciphertext IS NULL) = (value_mask IS NULL)
  ),
  CONSTRAINT ck_custom_list_values_text CHECK (
    value_text IS NULL OR (value_text <> '' AND char_length(value_text) <= 10000)
  ),
  CONSTRAINT ck_custom_list_values_mask CHECK (value_mask IS NULL OR char_length(value_mask) <= 16),
  CONSTRAINT ck_custom_list_values_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX ix_custom_list_values_school_list_row
  ON app.custom_list_values (school_id, list_id, row_id);
CREATE INDEX ix_custom_list_values_school_column
  ON app.custom_list_values (school_id, column_id);
CREATE INDEX ix_custom_list_values_school_option
  ON app.custom_list_values (school_id, option_id) WHERE option_id IS NOT NULL;
CREATE INDEX ix_custom_list_values_school_updated_by
  ON app.custom_list_values (school_id, updated_by) WHERE updated_by IS NOT NULL;

REVOKE ALL PRIVILEGES ON TABLE app.custom_list_values FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.custom_list_values TO studafy_app;
SELECT app.apply_tenant_isolation('app', 'custom_list_values');

CREATE POLICY role_scope_visibility ON app.custom_list_values
  AS RESTRICTIVE
  FOR SELECT
  TO studafy_app
  USING (
    EXISTS (
      SELECT 1
      FROM app.custom_lists AS list
      WHERE list.id = custom_list_values.list_id AND list.school_id = custom_list_values.school_id
    )
  );

-- 5 -------------------------------------------------------------------------------------------------

-- The school's totals for the caps. The caps are the school's, but app.custom_lists and
-- app.custom_list_rows are scoped to the caller's audience, so a principal counting them would miss
-- every admin-only list and could pass the cap. Two integers, no row data: SECURITY DEFINER under
-- tenant_isolation (the owner is still bound by app.school_id), exactly the current school's counts.
CREATE FUNCTION app.custom_list_usage(OUT lists int, OUT list_rows int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT
    (SELECT count(*)::int FROM app.custom_lists
      WHERE school_id = current_setting('app.school_id')::uuid),
    (SELECT count(*)::int FROM app.custom_list_rows
      WHERE school_id = current_setting('app.school_id')::uuid)
$function$;

REVOKE ALL ON FUNCTION app.custom_list_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.custom_list_usage() TO studafy_app;

RESET ROLE;
