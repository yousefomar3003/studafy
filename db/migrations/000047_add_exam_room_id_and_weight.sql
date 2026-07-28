-- Adds room assignment and gradebook weight to exams. room_id is nullable because not every
-- exam requires a physical room; weight defaults to 1 and must be positive, representing the
-- exam's contribution when gradebook-linked.

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
SET ROLE studafy_admin;

ALTER TABLE app.exams
  ADD COLUMN room_id uuid,
  ADD COLUMN weight numeric(10, 2) NOT NULL DEFAULT 1;

ALTER TABLE app.exams
  ADD CONSTRAINT fk_exams_room FOREIGN KEY (room_id, school_id)
    REFERENCES app.rooms (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE app.exams
  ADD CONSTRAINT ck_exams_weight CHECK (weight > 0);

CREATE INDEX idx_exams_school_room_id ON app.exams (school_id, room_id, id) WHERE room_id IS NOT NULL;

RESET ROLE;
