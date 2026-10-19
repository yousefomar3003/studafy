-- Grade revisions: a teacher's correction to grades that are already published. A published
-- submission is frozen (000013's transition trigger allows nothing out of `published`), so a later
-- change cannot go back through draft without pulling the grades out of the student's and parents'
-- view. Instead the teacher files a revision -- the new scores plus a reason -- and the published
-- grades stay exactly as they are until a school administrator or principal approves it from the
-- approvals queue. Approval writes the new scores onto app.grades in one transaction; rejection
-- leaves them untouched and records why.
--
-- Depends on 000013 (app.grade_submissions, app.grades), 000037 (app.teaches_gradebook,
-- app.current_user_is_school_admin), 000007 (app.users), and 000006 (app.apply_tenant_isolation).
--
-- The proposed scores live in app.grade_revision_items, one row per corrected grade record and
-- immutable once filed. `previous_score` is the published score when the revision was filed, so a
-- reviewer sees old -> new and the approval can refuse to apply over a score that moved since.
--
-- Workflow: pending -> approved | rejected | withdrawn. At most one revision per submission is
-- pending at a time; a teacher with a further correction withdraws the pending one and files again.

SET ROLE studafy_admin;

CREATE TABLE app.grade_revisions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_grade_revisions PRIMARY KEY,
  school_id uuid NOT NULL,
  grade_submission_id uuid NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requested_by_user_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by_user_id uuid,
  decided_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_grade_revisions_id_school UNIQUE (id, school_id),

  CONSTRAINT fk_grade_revisions_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_grade_revisions_submission FOREIGN KEY (grade_submission_id, school_id)
    REFERENCES app.grade_submissions (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_grade_revisions_requested_by FOREIGN KEY (requested_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_grade_revisions_decided_by FOREIGN KEY (decided_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_grade_revisions_reason CHECK (
    btrim(reason) <> '' AND char_length(reason) <= 2000
  ),
  CONSTRAINT ck_grade_revisions_status CHECK (
    status IN ('pending', 'approved', 'rejected', 'withdrawn')
  ),
  -- An approval or rejection says who decided and when; a pending or withdrawn revision says neither.
  CONSTRAINT ck_grade_revisions_decision CHECK (
    (status IN ('approved', 'rejected')) = (decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)
  ),
  -- A rejection always says why, and only a rejection carries a rejection reason.
  CONSTRAINT ck_grade_revisions_rejection CHECK (
    (status = 'rejected') = (rejection_reason IS NOT NULL)
  ),
  CONSTRAINT ck_grade_revisions_rejection_reason CHECK (
    rejection_reason IS NULL
    OR (btrim(rejection_reason) <> '' AND char_length(rejection_reason) <= 2000)
  ),
  CONSTRAINT ck_grade_revisions_timestamps CHECK (updated_at >= created_at)
);

-- One pending revision per submission: a second filing is a 409, not a second queue row.
CREATE UNIQUE INDEX uq_grade_revisions_pending
  ON app.grade_revisions (school_id, grade_submission_id)
  WHERE status = 'pending';

-- The approvals queue reads every pending revision in the school, newest first.
CREATE INDEX idx_grade_revisions_school_status_requested
  ON app.grade_revisions (school_id, status, requested_at DESC, id);
CREATE INDEX idx_grade_revisions_requested_by
  ON app.grade_revisions (requested_by_user_id, school_id);
CREATE INDEX idx_grade_revisions_decided_by
  ON app.grade_revisions (decided_by_user_id, school_id)
  WHERE decided_by_user_id IS NOT NULL;

REVOKE ALL PRIVILEGES ON TABLE app.grade_revisions FROM PUBLIC;
-- No DELETE: a revision is part of the grade's audit trail, withdrawn or not.
GRANT SELECT, INSERT, UPDATE ON TABLE app.grade_revisions TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'grade_revisions');

-- Revisions are staff-only. A student or parent sees the published grade, never a pending
-- correction to it: readable by school admins/principals and by the gradebook's own teacher. The
-- same SECURITY DEFINER shape as app.can_read_grade (000037) minus its parent/student arm, so the
-- submission lookup runs as studafy_admin and sees only tenant_isolation.
CREATE FUNCTION app.can_read_grade_revision(target_grade_submission_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.current_user_is_school_admin()
    OR EXISTS (
      SELECT 1
      FROM app.grade_submissions AS gs
      WHERE gs.id = target_grade_submission_id
        AND gs.school_id = current_setting('app.school_id')::uuid
        AND app.teaches_gradebook(gs.gradebook_id)
    )
$function$;

REVOKE ALL ON FUNCTION app.can_read_grade_revision(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_read_grade_revision(uuid) TO studafy_app;

CREATE POLICY role_scope_visibility ON app.grade_revisions
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_grade_revision(grade_submission_id));

-- One proposed score per grade record. Insert-only: a filed revision's content never changes, only
-- its status on app.grade_revisions. The grade record must belong to the revised submission; the
-- API checks that before inserting, the composite FKs keep both rows inside the school.
CREATE TABLE app.grade_revision_items (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_grade_revision_items PRIMARY KEY,
  school_id uuid NOT NULL,
  grade_revision_id uuid NOT NULL,
  grade_id uuid NOT NULL,
  previous_score numeric(10,2),
  new_score numeric(10,2),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- School-leading, like every tenant table's lookup index; also serves "items of this revision".
  CONSTRAINT uq_grade_revision_items_revision_grade UNIQUE (school_id, grade_revision_id, grade_id),

  CONSTRAINT fk_grade_revision_items_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_grade_revision_items_revision FOREIGN KEY (grade_revision_id, school_id)
    REFERENCES app.grade_revisions (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_grade_revision_items_grade FOREIGN KEY (grade_id, school_id)
    REFERENCES app.grades (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_grade_revision_items_previous_score CHECK (previous_score IS NULL OR previous_score >= 0),
  CONSTRAINT ck_grade_revision_items_new_score CHECK (new_score IS NULL OR new_score >= 0),
  -- A revision item that changes nothing is noise in the reviewer's queue.
  CONSTRAINT ck_grade_revision_items_changes_score CHECK (previous_score IS DISTINCT FROM new_score)
);

CREATE INDEX idx_grade_revision_items_grade
  ON app.grade_revision_items (grade_id, school_id);

REVOKE ALL PRIVILEGES ON TABLE app.grade_revision_items FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE app.grade_revision_items TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'grade_revision_items');

-- Same audience as the revision itself, resolved through the owning revision as studafy_admin.
CREATE FUNCTION app.can_read_grade_revision_item(target_grade_revision_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.grade_revisions AS gr
    WHERE gr.id = target_grade_revision_id
      AND gr.school_id = current_setting('app.school_id')::uuid
      AND app.can_read_grade_revision(gr.grade_submission_id)
  )
$function$;

REVOKE ALL ON FUNCTION app.can_read_grade_revision_item(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_read_grade_revision_item(uuid) TO studafy_app;

CREATE POLICY role_scope_visibility ON app.grade_revision_items
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.can_read_grade_revision_item(grade_revision_id));

COMMENT ON TABLE app.grade_revision_items IS
  'The proposed score for each grade record a grade revision corrects; immutable once filed.';

COMMENT ON TABLE app.grade_revisions IS
  'Teacher corrections to published grades, held for school-admin/principal approval; published scores change only on approval.';

RESET ROLE;
