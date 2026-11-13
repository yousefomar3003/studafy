-- ST-103: file attachments for assignments.
--
-- app.assignments has existed since 000011 but had nowhere to record the files a teacher attaches
-- to a piece of coursework. This adds that table, modelled column-for-column on app.materials
-- (000011) -- the schema's existing "a row that points at a stored object" shape -- rather than
-- inventing a second convention for the same thing.
--
-- THE STORAGE KEY CHECK IS A TENANT BOUNDARY, NOT A FORMAT CHECK.
-- ck_assignment_attachments_storage_key pins the key to '^permanent/<this row's school_id>/...',
-- which is docs/runbooks/storage-conventions.md's scheme with the school segment resolved against
-- the row itself. The application performs the same check before it ever calls the storage service
-- (apps/api/src/lib/storage/keys.ts); this is the half that still holds if that code is bypassed or
-- wrong. Neither layer is sufficient alone -- the app check prevents an object from being copied
-- into another school's prefix, and this one prevents a row from claiming an object there.

SET ROLE studafy_admin;

CREATE TABLE app.assignment_attachments (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_assignment_attachments PRIMARY KEY,
  school_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  uploaded_by_user_id uuid NOT NULL,
  storage_key text NOT NULL,
  original_file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  checksum_sha256 text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_assignment_attachments_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_assignment_attachments_storage_key UNIQUE (storage_key),
  CONSTRAINT fk_assignment_attachments_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- CASCADE, unlike every other composite FK in this schema: an attachment has no meaning apart
  -- from its assignment, and deleting an assignment with no submissions is a supported operation
  -- (see deleteAssignment in the assignments service). RESTRICT here would make that operation
  -- fail on any assignment that ever had a file attached.
  CONSTRAINT fk_assignment_attachments_assignment FOREIGN KEY (assignment_id, school_id)
    REFERENCES app.assignments (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_assignment_attachments_uploaded_by FOREIGN KEY (uploaded_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_assignment_attachments_storage_key CHECK (
    storage_key = btrim(storage_key)
    AND storage_key ~ ('^permanent/' || school_id::text || '/[^/]+/[^/]+$')
  ),
  CONSTRAINT ck_assignment_attachments_original_file_name CHECK (
    original_file_name = btrim(original_file_name) AND original_file_name <> ''
    AND original_file_name !~ '[/\\]'
  ),
  CONSTRAINT ck_assignment_attachments_mime_type CHECK (
    mime_type = btrim(mime_type) AND mime_type ~ '^[^/[:space:]]+/[^/[:space:]]+$'
  ),
  CONSTRAINT ck_assignment_attachments_size CHECK (size_bytes > 0),
  CONSTRAINT ck_assignment_attachments_checksum CHECK (
    checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_assignment_attachments_timestamps CHECK (updated_at >= created_at)
);

-- Tenant-leading, matching every other index in this schema so it stays usable under
-- school_id = current_setting('app.school_id')::uuid. Serves the batched attachment hydration the
-- list endpoint performs (one query for all assignments on a page, not one per assignment).
CREATE INDEX idx_assignment_attachments_school_assignment
  ON app.assignment_attachments (school_id, assignment_id, created_at, id);

CREATE INDEX idx_assignment_attachments_school_uploaded_by
  ON app.assignment_attachments (school_id, uploaded_by_user_id, id);

-- 000011 gave assignments only a class-leading due_at index. The ST-103 list endpoint paginates on
-- (due_at, id) across every class the caller can see, which that index cannot serve: its leading
-- class_id column is unconstrained in the unfiltered case.
CREATE INDEX idx_assignments_school_due_at
  ON app.assignments (school_id, due_at, id);

REVOKE ALL PRIVILEGES ON TABLE app.assignment_attachments FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.assignment_attachments TO studafy_app;

-- Applies BOTH the permissive tenant_isolation policy and the school_id immutability trigger:
-- 000025 rewrapped this function to do the two together, so a single call is the whole boundary.
SELECT app.apply_tenant_isolation('app', 'assignment_attachments');

-- ---------------------------------------------------------------------------
-- Role scope (extends 000037)
-- ---------------------------------------------------------------------------

-- Resolves an attachment's owning assignment to its class and defers to app.can_read_class, so an
-- attachment is exactly as visible as the assignment it hangs off -- admin, the class's teacher, an
-- enrolled student, or a linked parent.
--
-- SECURITY DEFINER for the reason 000037's header sets out at length: this function is called from
-- a RESTRICTIVE policy and itself reads app.assignments, which carries its own restrictive policy.
-- A SECURITY INVOKER lookup would re-enter that policy and recurse. Owned by studafy_admin, so its
-- reads run with only the permissive tenant_isolation policy in force -- still school-scoped,
-- because every predicate below pins school_id to the app.school_id GUC.
CREATE FUNCTION app.can_read_assignment(target_assignment_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.assignments AS a
    WHERE a.id = target_assignment_id
      AND a.school_id = current_setting('app.school_id')::uuid
      AND app.can_read_class(a.class_id)
  )
$function$;

-- Grants mirror 000037's block for the helpers it defines: revoked from PUBLIC, executable by the
-- runtime role, which evaluates it from inside the policy expression below. Ownership is already
-- studafy_admin by virtue of the SET ROLE at the top of this file.
REVOKE ALL ON FUNCTION app.can_read_assignment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_read_assignment(uuid) TO studafy_app;

CREATE POLICY role_scope_visibility ON app.assignment_attachments
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_assignment(assignment_id));

RESET ROLE;
