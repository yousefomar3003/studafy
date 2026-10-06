-- School calendar events: holidays, school events, meetings, and exam periods that sit on the school
-- calendar alongside the academic year's terms (000009) and each class's exams (000011).
--
-- Dates, not timestamps: every kind here is a whole-day entry in the school's own calendar, so a
-- `date` range (inclusive on both ends) avoids timezone drift between the browser, the API, and the
-- school's configured timezone. A single-day entry has starts_on = ends_on.
--
-- Read by every staff role that holds calendarEvent:read and managed by calendarEvent:manage
-- (PRINCIPAL and ORG_ADMIN; see packages/constants/src/permissions.ts). Tenant isolation only --
-- the calendar is school-wide by nature, so there is no per-role row scoping.

SET ROLE studafy_admin;

CREATE TABLE app.school_events (
  id          uuid        DEFAULT gen_random_uuid() CONSTRAINT pk_school_events PRIMARY KEY,
  school_id   uuid        NOT NULL,
  created_by  uuid        NOT NULL,
  title       text        NOT NULL,
  description text,
  kind        text        NOT NULL CHECK (kind IN ('holiday', 'event', 'meeting', 'exam_period')),
  starts_on   date        NOT NULL,
  ends_on     date        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_school_events_id_school UNIQUE (id, school_id),

  CONSTRAINT fk_school_events_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_school_events_created_by
    FOREIGN KEY (created_by, school_id) REFERENCES app.users (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_school_events_title CHECK (
    title = btrim(title) AND title <> '' AND char_length(title) <= 200
  ),
  CONSTRAINT ck_school_events_description CHECK (
    description IS NULL OR char_length(description) <= 2000
  ),
  CONSTRAINT ck_school_events_date_range CHECK (ends_on >= starts_on),
  CONSTRAINT ck_school_events_timestamps CHECK (updated_at >= created_at)
);

-- The calendar's only read path: events overlapping a [from, to] window.
CREATE INDEX idx_school_events_school_dates
  ON app.school_events (school_id, starts_on, ends_on);

REVOKE ALL PRIVILEGES ON TABLE app.school_events FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.school_events TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'school_events');

RESET ROLE;
