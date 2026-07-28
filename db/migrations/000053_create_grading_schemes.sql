-- Versioned grading schemes per academic term. Each modification creates a new version;
-- prior versions are immutable — studafy_app receives only SELECT and INSERT, never UPDATE
-- or DELETE. Ordered grade boundaries are normalized into grading_scheme_boundaries so the
-- database can enforce tenant ownership and relational integrity.
--
-- Also adds a nullable grading_scheme_id FK on app.gradebooks so each gradebook can be
-- linked to a specific scheme version.

-- app.gradebooks already has forced RLS. Its new grading_scheme_id column is nullable and therefore
-- every existing row satisfies the new foreign key. Set a non-matching tenant context so the
-- validation scan can execute without weakening RLS or leaving an unvalidated constraint behind.
SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

SET ROLE studafy_admin;

-- 1. Grading schemes and their ordered boundaries (append-only for the app role)

CREATE TABLE app.grading_schemes (
  id                 uuid DEFAULT gen_random_uuid() CONSTRAINT pk_grading_schemes PRIMARY KEY,
  school_id          uuid NOT NULL,
  term_id            uuid NOT NULL,
  academic_year_id   uuid NOT NULL,
  version            integer NOT NULL DEFAULT 1,
  name               text NOT NULL,
  scheme_type        text NOT NULL,
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

REVOKE ALL PRIVILEGES ON TABLE app.grading_schemes FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT ON TABLE app.grading_schemes TO studafy_app;
-- No UPDATE or DELETE: versions are immutable.

SELECT app.apply_tenant_isolation('app', 'grading_schemes');

CREATE TABLE app.grading_scheme_boundaries (
  id                uuid DEFAULT gen_random_uuid()
                    CONSTRAINT pk_grading_scheme_boundaries PRIMARY KEY,
  school_id         uuid NOT NULL,
  grading_scheme_id uuid NOT NULL,
  position          integer NOT NULL,
  label             text NOT NULL,
  min_percentage    numeric NOT NULL,
  max_percentage    numeric NOT NULL,
  gpa_points        numeric,
  created_at        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_grading_scheme_boundaries_position
    UNIQUE (school_id, grading_scheme_id, position),

  CONSTRAINT fk_grading_scheme_boundaries_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_grading_scheme_boundaries_scheme
    FOREIGN KEY (grading_scheme_id, school_id)
    REFERENCES app.grading_schemes (id, school_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,

  CONSTRAINT ck_grading_scheme_boundaries_position
    CHECK (position >= 0),

  CONSTRAINT ck_grading_scheme_boundaries_label
    CHECK (label = btrim(label) AND label <> ''),

  CONSTRAINT ck_grading_scheme_boundaries_range
    CHECK (
      min_percentage >= 0
      AND min_percentage <= 100
      AND max_percentage >= 0
      AND max_percentage <= 100
      AND min_percentage <= max_percentage
    )
);

REVOKE ALL PRIVILEGES ON TABLE app.grading_scheme_boundaries FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT ON TABLE app.grading_scheme_boundaries TO studafy_app;
-- No UPDATE or DELETE: boundaries are immutable with their parent scheme version.

SELECT app.apply_tenant_isolation('app', 'grading_scheme_boundaries');

-- 2. Link gradebooks to a specific grading scheme version

ALTER TABLE app.gradebooks
  ADD COLUMN grading_scheme_id uuid;

ALTER TABLE app.gradebooks
  ADD CONSTRAINT fk_gradebooks_grading_scheme
    FOREIGN KEY (grading_scheme_id, school_id)
    REFERENCES app.grading_schemes (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE INDEX idx_gradebooks_school_grading_scheme_id
  ON app.gradebooks (school_id, grading_scheme_id)
  WHERE grading_scheme_id IS NOT NULL;

RESET ROLE;
