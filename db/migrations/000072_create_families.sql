-- ST-126: first-class tenant households.
--
-- Existing guardian relationships remain the canonical parent-to-student edge. A family groups
-- those edges without duplicating either parent or student membership in another table.

SET LOCAL ROLE studafy_admin;

CREATE TABLE app.families (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_families PRIMARY KEY,
  school_id uuid NOT NULL,
  display_name text NOT NULL,
  primary_parent_user_id uuid NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_families_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_families_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_families_primary_parent
    FOREIGN KEY (primary_parent_user_id, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_families_display_name CHECK (
    display_name = btrim(display_name) AND display_name <> '' AND length(display_name) <= 200
  ),
  CONSTRAINT ck_families_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX idx_families_school_created
  ON app.families (school_id, created_at DESC, id);
CREATE INDEX idx_families_school_primary_parent
  ON app.families (school_id, primary_parent_user_id, created_at, id);

ALTER TABLE app.parent_child_links
  ADD COLUMN family_id uuid;

-- Existing tenant tables use forced RLS even for their owner. Backfill one tenant at a time with
-- the same transaction-local GUC every runtime query uses; an all-tenant query would fail closed.
-- There was no household identity before this migration, so the only lossless backfill is one
-- household per parent. Administrators can later move guardian links to consolidate co-parents.
DO $backfill$
DECLARE
  tenant_id uuid;
BEGIN
  FOR tenant_id IN SELECT id FROM app.schools LOOP
    PERFORM pg_catalog.set_config('app.school_id', tenant_id::text, true);

    INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
    SELECT
      pcl.school_id,
      left(COALESCE(NULLIF(btrim(u.display_name), ''), 'Family'), 200),
      pcl.parent_user_id
    FROM app.parent_child_links AS pcl
    JOIN app.users AS u
      ON u.id = pcl.parent_user_id
     AND u.school_id = pcl.school_id
    WHERE pcl.school_id = tenant_id
    GROUP BY pcl.school_id, pcl.parent_user_id, u.display_name;

    UPDATE app.parent_child_links AS pcl
    SET family_id = family.id
    FROM app.families AS family
    WHERE pcl.school_id = tenant_id
      AND family.school_id = pcl.school_id
      AND family.primary_parent_user_id = pcl.parent_user_id;
  END LOOP;

  PERFORM pg_catalog.set_config(
    'app.school_id',
    '00000000-0000-0000-0000-000000000000',
    true
  );
END
$backfill$;

ALTER TABLE app.parent_child_links
  ALTER COLUMN family_id SET NOT NULL,
  ADD CONSTRAINT fk_parent_child_links_family
    FOREIGN KEY (family_id, school_id) REFERENCES app.families (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE INDEX idx_parent_child_links_school_family_student_parent
  ON app.parent_child_links (school_id, family_id, student_id, parent_user_id);

REVOKE ALL PRIVILEGES ON TABLE app.families FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.families TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'families');

COMMENT ON TABLE app.families IS
  'Tenant household identity. Parent-to-student membership remains canonical in parent_child_links.';
COMMENT ON COLUMN app.families.primary_parent_user_id IS
  'Administrative household owner; additional guardians are represented by family-scoped parent_child_links.';
COMMENT ON COLUMN app.parent_child_links.family_id IS
  'Household that groups this exact guardian-to-student relationship for family statements.';

RESET ROLE;
