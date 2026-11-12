-- Academic transcripts: every year of a student's finalized annual results on one document, with a
-- cumulative average and GPA (for example, for university applications).
--
-- A transcript is issued the way a certificate is (000160): rendered once from the finalized
-- result rows, stored whole in `content` with its SHA-256, and never edited -- only superseded by a
-- reissue or revoked. It is a separate table, not a new app.certificates kind, because a
-- certificate belongs to exactly one academic year and one finalization (both NOT NULL foreign
-- keys), while a transcript covers several.
--
-- app.transcript_finalizations records which annual finalizations a transcript was built from, one
-- row per covered year. Each row references the student's own overall result in that finalization,
-- so a transcript can only cover results that exist and belong to its student. When one of those
-- finalizations is later superseded by a correction, or a newer year is finalized, the API reports
-- the transcript as needing a reissue; the stored document itself never changes.
--
-- Visibility: school leadership, the student and the student's linked parents
-- (app.current_user_is_school_admin, app.is_related_to_student). Unlike a certificate, a section's
-- subject teachers do not see transcripts: a transcript spans years and sections they did not teach.

SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

SET ROLE studafy_admin;

CREATE TABLE app.transcripts (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_transcripts PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  serial_number text NOT NULL,
  status text NOT NULL DEFAULT 'issued',
  issued_by_user_id uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  supersedes_id uuid,
  reissue_reason text,
  superseded_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id uuid,
  revoke_reason text,
  -- The rendered transcript exactly as issued. Never rebuilt from live data.
  content jsonb NOT NULL,
  content_sha256 text NOT NULL,
  CONSTRAINT uq_transcripts_school_serial UNIQUE (school_id, serial_number),
  CONSTRAINT uq_transcripts_id_school UNIQUE (id, school_id),
  CONSTRAINT uq_transcripts_id_student_school UNIQUE (id, student_id, school_id),
  CONSTRAINT fk_transcripts_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_transcripts_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_transcripts_issued_by FOREIGN KEY (issued_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_transcripts_revoked_by FOREIGN KEY (revoked_by_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_transcripts_supersedes FOREIGN KEY (supersedes_id, school_id)
    REFERENCES app.transcripts (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_transcripts_serial CHECK (serial_number = btrim(serial_number) AND serial_number <> ''),
  CONSTRAINT ck_transcripts_status CHECK (status IN ('issued', 'superseded', 'revoked')),
  CONSTRAINT ck_transcripts_reissue CHECK (
    (supersedes_id IS NULL) = (reissue_reason IS NULL)
    AND (reissue_reason IS NULL OR (btrim(reissue_reason) <> '' AND char_length(reissue_reason) <= 2000))
  ),
  CONSTRAINT ck_transcripts_superseded CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
  CONSTRAINT ck_transcripts_revoked CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL
      AND revoke_reason IS NOT NULL AND btrim(revoke_reason) <> '')
  ),
  CONSTRAINT ck_transcripts_revoke_reason CHECK (
    revoke_reason IS NULL OR char_length(revoke_reason) <= 2000
  ),
  CONSTRAINT ck_transcripts_content CHECK (jsonb_typeof(content) = 'object'),
  CONSTRAINT ck_transcripts_sha CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
);
-- One current transcript per student: issuing again goes through a reissue.
CREATE UNIQUE INDEX uq_transcripts_current
  ON app.transcripts (school_id, student_id) WHERE status = 'issued';
CREATE INDEX idx_transcripts_school_student
  ON app.transcripts (school_id, student_id, issued_at DESC);
CREATE INDEX idx_transcripts_student_fk ON app.transcripts (student_id, school_id);
CREATE INDEX idx_transcripts_issued_by_fk ON app.transcripts (issued_by_user_id, school_id);
CREATE INDEX idx_transcripts_revoked_by_fk ON app.transcripts (revoked_by_user_id, school_id)
  WHERE revoked_by_user_id IS NOT NULL;
CREATE INDEX idx_transcripts_supersedes_fk ON app.transcripts (supersedes_id, school_id)
  WHERE supersedes_id IS NOT NULL;

CREATE TABLE app.transcript_finalizations (
  transcript_id uuid NOT NULL,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  finalization_id uuid NOT NULL,
  CONSTRAINT pk_transcript_finalizations PRIMARY KEY (school_id, transcript_id, finalization_id),
  CONSTRAINT fk_transcript_finalizations_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_transcript_finalizations_transcript FOREIGN KEY (transcript_id, student_id, school_id)
    REFERENCES app.transcripts (id, student_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Only a result the student actually has can be covered.
  CONSTRAINT fk_transcript_finalizations_overall_result
    FOREIGN KEY (finalization_id, student_id, school_id)
    REFERENCES app.student_overall_results (finalization_id, student_id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX idx_transcript_finalizations_transcript_fk
  ON app.transcript_finalizations (transcript_id, student_id, school_id);
CREATE INDEX idx_transcript_finalizations_overall_result_fk
  ON app.transcript_finalizations (finalization_id, student_id, school_id);

COMMENT ON TABLE app.transcripts IS
  'Issued multi-year academic transcripts with their rendered content (000207); never edited, only superseded or revoked.';
COMMENT ON TABLE app.transcript_finalizations IS
  'The annual finalizations a transcript was built from, one per covered year (000207); written once with the transcript.';

-- A transcript's content never changes. It can be superseded by a reissue or revoked, once.
CREATE FUNCTION app.enforce_transcript_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'issued transcripts cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'issued' OR NEW.status NOT IN ('superseded', 'revoked') THEN
    RAISE EXCEPTION 'transcript status cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW.school_id, NEW.student_id, NEW.serial_number, NEW.issued_by_user_id,
      NEW.issued_at, NEW.supersedes_id, NEW.reissue_reason, NEW.content, NEW.content_sha256)
     IS DISTINCT FROM
     (OLD.id, OLD.school_id, OLD.student_id, OLD.serial_number, OLD.issued_by_user_id,
      OLD.issued_at, OLD.supersedes_id, OLD.reissue_reason, OLD.content, OLD.content_sha256) THEN
    RAISE EXCEPTION 'an issued transcript is immutable apart from its status'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'superseded' THEN
    NEW.superseded_at := CURRENT_TIMESTAMP;
  ELSE
    NEW.revoked_at := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_transcripts_immutable
BEFORE UPDATE OR DELETE ON app.transcripts
FOR EACH ROW EXECUTE FUNCTION app.enforce_transcript_immutability();

ALTER FUNCTION app.enforce_transcript_immutability() OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.enforce_transcript_immutability() FROM PUBLIC, studafy_app;

-- 000002's default privileges grant studafy_app full DML on new tables; take it back, then grant
-- exactly what issuing needs. The covered-finalization rows are written once and never changed.
REVOKE ALL PRIVILEGES ON TABLE app.transcripts, app.transcript_finalizations
FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.transcripts TO studafy_app;
GRANT SELECT, INSERT ON TABLE app.transcript_finalizations TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'transcripts');
SELECT app.apply_tenant_isolation('app', 'transcript_finalizations');

CREATE POLICY role_scope_visibility ON app.transcripts
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.current_user_is_school_admin() OR app.is_related_to_student(student_id));

CREATE POLICY role_scope_visibility ON app.transcript_finalizations
  AS RESTRICTIVE FOR SELECT TO studafy_app
  USING (app.current_user_is_school_admin() OR app.is_related_to_student(student_id));

RESET ROLE;
