-- Third-party AI data-sharing consent (ST-305): the durable record that a user agreed to their AI
-- inputs being sent to the external model provider, and when they withdrew that agreement.
--
-- Depends on 000007 (app.users, uq_users_id_school) and 000006 (app.apply_tenant_isolation).
--
-- One row per grant. A withdrawal stamps `withdrawn_at` on the live row instead of deleting it, so
-- the table is the complete consent history for a user: what they agreed to (`disclosure_version`,
-- `provider`, `data_categories` -- a snapshot of the disclosure they were shown), when, and when it
-- ended. At most one row per user is live at a time (uq_ai_data_sharing_consents_live). A grant of a
-- newer disclosure version supersedes the live row by withdrawing it in the same transaction.
--
-- The API's consent gate (apps/api/src/modules/ai/gate/consent-gate.ts) reads the live row before
-- any /api/ai/* route that calls the model; every grant and withdrawal also writes an
-- app.audit_logs row in the same transaction (see apps/api/src/modules/ai/consent/persistence.ts).
--
-- studafy_app gets no DELETE: history is only ever appended to or stamped.

SET ROLE studafy_admin;

CREATE TABLE app.ai_data_sharing_consents (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ai_data_sharing_consents PRIMARY KEY,
  school_id uuid NOT NULL,
  user_id uuid NOT NULL,
  disclosure_version text NOT NULL,
  provider text NOT NULL,
  data_categories text[] NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  withdrawn_at timestamptz,

  CONSTRAINT uq_ai_data_sharing_consents_id_school UNIQUE (id, school_id),

  CONSTRAINT fk_ai_data_sharing_consents_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_data_sharing_consents_user FOREIGN KEY (user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_ai_data_sharing_consents_disclosure_version
    CHECK (disclosure_version = btrim(disclosure_version) AND disclosure_version <> ''),
  CONSTRAINT ck_ai_data_sharing_consents_provider
    CHECK (provider = btrim(provider) AND provider <> ''),
  CONSTRAINT ck_ai_data_sharing_consents_data_categories
    CHECK (cardinality(data_categories) > 0),
  CONSTRAINT ck_ai_data_sharing_consents_timestamps
    CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);

-- The gate's lookup and the "one live consent per user" rule in one index.
CREATE UNIQUE INDEX uq_ai_data_sharing_consents_live
  ON app.ai_data_sharing_consents (school_id, user_id)
  WHERE withdrawn_at IS NULL;

-- A user's consent history, newest first.
CREATE INDEX idx_ai_data_sharing_consents_school_user_granted_at
  ON app.ai_data_sharing_consents (school_id, user_id, granted_at DESC);

REVOKE ALL PRIVILEGES ON TABLE app.ai_data_sharing_consents FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE app.ai_data_sharing_consents TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'ai_data_sharing_consents');

COMMENT ON TABLE app.ai_data_sharing_consents IS
  'Third-party AI data-sharing consent history (ST-305): one row per grant, withdrawal stamps withdrawn_at; the API refuses model calls without a live row for the current disclosure version.';

RESET ROLE;
