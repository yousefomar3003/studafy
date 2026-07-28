-- Assessment categories define weighted grading buckets (e.g. Homework 20%, Midterm 30%,
-- Final Exam 50%) per gradebook. The total sum of active category weights must equal exactly
-- 100%, but this is enforced in the application layer to produce machine-readable error
-- codes (INVALID_GRADEBOOK_WEIGHT_TOTAL). The DB CHECK constraint below guards individual
-- row sanity only (0 <= weight <= 100).

SET ROLE studafy_admin;

CREATE TABLE app.assessment_categories (
  id            uuid DEFAULT gen_random_uuid() CONSTRAINT pk_assessment_categories PRIMARY KEY,
  school_id     uuid NOT NULL,
  gradebook_id  uuid NOT NULL,
  name          text NOT NULL,
  weight        numeric(5,2) NOT NULL,
  description   text,
  sort_order    integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_assessment_categories_gradebook_name
    UNIQUE (school_id, gradebook_id, name),

  CONSTRAINT fk_assessment_categories_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT fk_assessment_categories_gradebook
    FOREIGN KEY (gradebook_id, school_id)
    REFERENCES app.gradebooks (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_assessment_category_weight
    CHECK (weight >= 0 AND weight <= 100),

  CONSTRAINT ck_assessment_category_name
    CHECK (name = btrim(name) AND name <> ''),

  CONSTRAINT ck_assessment_category_timestamps
    CHECK (updated_at >= created_at)
);

-- Primary lookup: all categories for a gradebook, ordered by sort_order.
CREATE INDEX idx_assessment_categories_school_gradebook_id
  ON app.assessment_categories (school_id, gradebook_id, sort_order);

REVOKE ALL PRIVILEGES ON TABLE app.assessment_categories FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.assessment_categories TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'assessment_categories');

RESET ROLE;
