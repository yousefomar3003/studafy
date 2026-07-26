-- Tracks bulk invitation dispatch: admin issues invitations in batches with per-recipient status.
-- Each recipient's state is individually trackable and retriable on failure.

SET ROLE studafy_admin;

CREATE TYPE app.bulk_invite_status AS ENUM (
  'pending', 'processing', 'completed', 'failed'
);

CREATE TYPE app.bulk_invite_recipient_status AS ENUM (
  'pending', 'sent', 'failed'
);

CREATE TABLE app.bulk_invites (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id       uuid NOT NULL,
  created_by      uuid NOT NULL,
  status          app.bulk_invite_status NOT NULL DEFAULT 'pending',
  role            app.user_role NOT NULL,
  expiry_days     int NOT NULL DEFAULT 7,
  target_mode     text NOT NULL,
  target_ref      text,
  total_count     int NOT NULL DEFAULT 0,
  sent_count      int NOT NULL DEFAULT 0,
  failed_count    int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at    timestamptz,

  CONSTRAINT uq_bulk_invites_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_bulk_invites_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id),
  CONSTRAINT fk_bulk_invites_user FOREIGN KEY (created_by, school_id)
    REFERENCES app.users (id, school_id)
);

CREATE INDEX idx_bulk_invites_school_status
  ON app.bulk_invites (school_id, status, created_at DESC);

CREATE TABLE app.bulk_invite_recipients (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  bulk_invite_id  uuid NOT NULL,
  school_id       uuid NOT NULL,
  email           text NOT NULL,
  normalized_email text NOT NULL,
  status          app.bulk_invite_recipient_status NOT NULL DEFAULT 'pending',
  invitation_id   uuid,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_bulk_invite_recipients_bulk FOREIGN KEY (bulk_invite_id, school_id)
    REFERENCES app.bulk_invites (id, school_id) ON DELETE CASCADE,
  CONSTRAINT fk_bulk_invite_recipients_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id)
);

CREATE INDEX idx_bulk_invite_recipients_bulk_status
  ON app.bulk_invite_recipients (bulk_invite_id, status);

CREATE UNIQUE INDEX uq_bulk_invite_recipients_email_per_bulk
  ON app.bulk_invite_recipients (bulk_invite_id, normalized_email);

SELECT app.apply_tenant_isolation('app', 'bulk_invites');
SELECT app.apply_tenant_isolation('app', 'bulk_invite_recipients');

REVOKE ALL PRIVILEGES ON TABLE app.bulk_invites FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE app.bulk_invites TO studafy_app;

REVOKE ALL PRIVILEGES ON TABLE app.bulk_invite_recipients FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE app.bulk_invite_recipients TO studafy_app;

REVOKE ALL ON TYPE app.bulk_invite_status FROM PUBLIC;
GRANT USAGE ON TYPE app.bulk_invite_status TO studafy_app;

REVOKE ALL ON TYPE app.bulk_invite_recipient_status FROM PUBLIC;
GRANT USAGE ON TYPE app.bulk_invite_recipient_status TO studafy_app;

RESET ROLE;
