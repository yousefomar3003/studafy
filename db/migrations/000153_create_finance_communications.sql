-- Every fee message sent to a guardian: the automatic "invoice issued" and "payment received"
-- notices, and the reminders and statements finance sends by hand.
--
-- One row per guardian per message. It is three things at once:
--
--   * the guard that keeps an automatic notice to one send. ERPNext delivers webhooks at least once
--     and the reconciliation job can confirm a payment the webhook already confirmed, so the
--     partial unique index below, not the caller, decides whether a notice goes out;
--   * the cooldown for reminders: the API refuses a second reminder to the same family within a
--     day, reading the newest row here;
--   * the history finance sees on a family's page ("reminded 3 days ago by Reem").
--
-- `delivered` is false when the guardian has turned that notification type off: the row still
-- records that finance tried, so the page can say so instead of implying the family was told.
-- `notification_id` is a plain uuid, not a foreign key: a guardian may delete the notification from
-- their inbox, and that must not erase the record that it was sent.

SET ROLE studafy_admin;

CREATE TABLE app.finance_communications (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_finance_communications PRIMARY KEY,
  school_id uuid NOT NULL,
  kind text NOT NULL,
  family_id uuid,
  student_id uuid,
  -- The ERPNext document the message is about: a Sales Invoice for invoice_issued, a Payment Entry
  -- for payment_received. NULL for reminders and statements, which are about the whole family.
  reference text,
  recipient_user_id uuid NOT NULL,
  delivered boolean NOT NULL,
  notification_id uuid,
  -- NULL when the system sent it (a webhook), otherwise the finance user who did.
  sent_by uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_finance_communications_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_finance_communications_family FOREIGN KEY (family_id, school_id)
    REFERENCES app.families (id, school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_finance_communications_student FOREIGN KEY (student_id, school_id)
    REFERENCES app.students (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_finance_communications_recipient FOREIGN KEY (recipient_user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_finance_communications_sent_by FOREIGN KEY (sent_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_finance_communications_kind CHECK (
    kind IN ('invoice_issued', 'payment_received', 'payment_reminder', 'statement')
  ),
  -- Document notices name their document; family messages name their family.
  CONSTRAINT ck_finance_communications_subject CHECK (
    (kind IN ('invoice_issued', 'payment_received') AND reference IS NOT NULL
      AND student_id IS NOT NULL)
    OR (kind IN ('payment_reminder', 'statement') AND family_id IS NOT NULL)
  ),
  CONSTRAINT ck_finance_communications_delivery CHECK (delivered = (notification_id IS NOT NULL))
);

-- One automatic notice per document per guardian, however many times ERPNext redelivers it.
CREATE UNIQUE INDEX uq_finance_communications_document_notice
  ON app.finance_communications (school_id, kind, reference, recipient_user_id)
  WHERE kind IN ('invoice_issued', 'payment_received');

-- A family's history, newest first; also the reminder cooldown lookup.
CREATE INDEX idx_finance_communications_family
  ON app.finance_communications (school_id, family_id, created_at DESC);
CREATE INDEX idx_finance_communications_student_fk
  ON app.finance_communications (student_id, school_id);
CREATE INDEX idx_finance_communications_recipient_fk
  ON app.finance_communications (recipient_user_id, school_id);
CREATE INDEX idx_finance_communications_sent_by_fk
  ON app.finance_communications (sent_by, school_id);
CREATE INDEX idx_finance_communications_family_fk
  ON app.finance_communications (family_id, school_id);

REVOKE ALL PRIVILEGES ON TABLE app.finance_communications FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT ON TABLE app.finance_communications TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'finance_communications');

RESET ROLE;
