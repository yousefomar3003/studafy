-- Versioned grading schemes per academic term. Each modification creates a new version;
-- prior versions are immutable — studafy_app receives only SELECT and INSERT, never UPDATE
-- or DELETE. grade_boundaries is a JSONB array:
--   [{ "label": "A", "min": 90, "max": 100, "gpa_points": 4.0 }, ...]
--
-- Also adds a nullable grading_scheme_id FK on app.gradebooks so each gradebook can be
-- linked to a specific scheme version.

SET ROLE studafy_admin;

-- 1. Grading schemes (append-only for the app role)

CREATE TABLE app.grading_schemes (
  id                 uuid DEFAULT gen_random_uuid() CONSTRAINT pk_grading_schemes PRIMARY KEY,
  school_id          uuid NOT NULL,
  term_id            uuid NOT NULL,
  academic_year_id   uuid NOT NULL,
  version            integer NOT NULL DEFAULT 1,
  name               text NOT NULL,
  scheme_type        text NOT NULL,
  grade_boundaries   jsonb NOT NULL,
  is_inherited       boolean NOT NULL DEFAULT false,
  created_by_user_id uuid,
  created_at         timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_grading_schemes_id_school
    UNIQUE (id, school_id),

  CONSTRAINT uq_grading_schemes_term_version
    UNIQUE (school_id, term_id, version),

  CONSTRAINT fk_grading_schemes_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_grading_schemes_term
    FOREIGN KEY (term_id, academic_year_id, school_id)
    REFERENCES app.terms (id, academic_year_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_grading_schemes_created_by
    FOREIGN KEY (created_by_user_id, school_id)
    REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_grading_scheme_type
    CHECK (scheme_type IN ('letter', 'percentage', 'gpa', 'numeric', 'pass_fail')),

  CONSTRAINT ck_grading_scheme_version
    CHECK (version >= 1),

  CONSTRAINT ck_grading_scheme_name
    CHECK (name = btrim(name) AND name <> ''),

  CONSTRAINT ck_grading_scheme_timestamps
    CHECK (updated_at >= created_at)
);

CREATE INDEX idx_grading_schemes_school_term_id
  ON app.grading_schemes (school_id, term_id, version);

REVOKE ALL PRIVILEGES ON TABLE app.grading_schemes FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE app.grading_schemes TO studafy_app;
-- No UPDATE or DELETE: versions are immutable.

SELECT app.apply_tenant_isolation('app', 'grading_schemes');

-- 2. Link gradebooks to a specific grading scheme version
--    NOT VALID is used because gradebooks has FORCE ROW LEVEL SECURITY
--    and studafy_admin has NOBYPASSRLS, so the validation scan would fail.
--    Since gradebooks is empty (new deployment), the constraint is trivially satisfied.

ALTER TABLE app.gradebooks
  ADD COLUMN grading_scheme_id uuid;

ALTER TABLE app.gradebooks
  ADD CONSTRAINT fk_gradebooks_grading_scheme
    FOREIGN KEY (grading_scheme_id, school_id)
    REFERENCES app.grading_schemes (id, school_id)
    ON UPDATE RESTRICT ON DELETE SET NULL NOT VALID;

CREATE INDEX idx_gradebooks_school_grading_scheme_id
  ON app.gradebooks (school_id, grading_scheme_id)
  WHERE grading_scheme_id IS NOT NULL;

RESET ROLE;
