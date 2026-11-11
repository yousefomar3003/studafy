-- Student imports name up to two parents per line (packages/student-import, "parent2_*" columns).
--
-- A completed import keeps the cells of columns its mapping did not read, tagged with the student
-- and the parent the line wrote (000179), so staff can later keep a column as a record field and so
-- a per-person erasure can find and delete them. A line now writes a second parent too, and that
-- parent must be just as findable: an unmapped "Mother's phone" column holds their data, and their
-- erasure has to delete it (apps/workers/src/queues/maintenance/imports-dsr.ts).

SET ROLE studafy_admin;

-- Validating the new foreign key scans app.student_import_rows, whose forced RLS applies the
-- tenant_isolation predicate even to the owner (see 000114, 000179). The new column is NULL on every
-- existing row, so the nil tenant's empty scan is exact.
SELECT pg_catalog.set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

ALTER TABLE app.student_import_rows
  ADD COLUMN parent2_user_id uuid,
  -- Cascade, as parent_user_id: a leftover cell exists only to be applied to this person's record.
  ADD CONSTRAINT fk_student_import_rows_parent2 FOREIGN KEY (parent2_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT ck_student_import_rows_parent2
    CHECK (parent2_user_id IS NULL OR student_id IS NOT NULL);

-- Per-person erasure deletes a person's leftover cells by this.
CREATE INDEX ix_student_import_rows_parent2
  ON app.student_import_rows (school_id, parent2_user_id)
  WHERE parent2_user_id IS NOT NULL;

COMMENT ON COLUMN app.student_import_rows.parent2_user_id IS
  'The second parent this line created or linked (000198); with student_id and parent_user_id, whose leftover cells these are.';

RESET ROLE;
