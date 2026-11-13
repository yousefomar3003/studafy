SET ROLE studafy_admin;

-- Load a dummy school_id so FK validation does not trip on the
-- tenant_isolation policy expressions that read app.school_id.
-- (studafy_admin bypasses RLS as the table owner, but during
--  ALTER TABLE ADD CONSTRAINT the planner may still evaluate the
--  current_setting call in the policy text; giving it a value
--  avoids the "unrecognized configuration parameter" error.)
SELECT pg_catalog.set_config('app.school_id', '00000000-0000-4000-8000-000000000001', true);

-- 1. Add UNIQUE (id, school_id) to scholarship_discount_cache so it can
--    serve as the target of a composite foreign key from award_cache.
ALTER TABLE app.scholarship_discount_cache
  ADD CONSTRAINT uq_scholarship_discount_cache_id_school
    UNIQUE (id, school_id);

-- 2. Replace fk_award_cache_student with a composite FK.
ALTER TABLE app.award_cache
  DROP CONSTRAINT fk_award_cache_student;

ALTER TABLE app.award_cache
  ADD CONSTRAINT fk_award_cache_student
    FOREIGN KEY (student_id, school_id) REFERENCES app.students (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

-- 3. Replace fk_award_cache_scholarship_discount with a composite FK.
ALTER TABLE app.award_cache
  DROP CONSTRAINT fk_award_cache_scholarship_discount;

ALTER TABLE app.award_cache
  ADD CONSTRAINT fk_award_cache_scholarship_discount
    FOREIGN KEY (scholarship_discount_id, school_id) REFERENCES app.scholarship_discount_cache (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

RESET ROLE;
