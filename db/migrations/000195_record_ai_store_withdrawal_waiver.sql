-- Record a student's waiver of the 14-day right of withdrawal when they buy the AI add-on in the app.
--
-- Under EU consumer law (Directive 2011/83/EU art. 16(m), as amended) a consumer who buys digital
-- content or a digital service keeps a 14-day right to withdraw unless they expressly asked for it to
-- start straight away and acknowledged that they lose the right once it does -- and the trader
-- confirms that on a durable medium. The Terms of Service say so (section 7.7). The mobile app now
-- asks for that request and acknowledgement with a required checkbox before it opens the store's
-- purchase sheet, and sends it with the purchase (POST /api/subscriptions/ai/store/purchases).
--
-- Columns on app.ai_subscriptions rather than a table: the row is the student's current AI add-on,
-- and the waiver belongs to the store purchase that (re)started it, named by
-- withdrawal_waiver_purchase_ref: the platform and the SHA-256 of the purchase's transaction id
-- (Apple's transactionId, Google's order id). A resubscription is a new transaction and a new
-- contract, so its waiver replaces the previous one; reporting the same transaction again (a retry,
-- "restore purchases") records nothing new. Hashed because Google falls back to the purchase token,
-- a credential for the purchase, when Play reports no order id, and this table is readable at tenant
-- level, unlike app.billing_events. A purchase from an app version that does not ask records nothing
-- and leaves an earlier purchase's waiver in place: it is still true, and its timestamps and
-- reference say which purchase it was for. Every recorded waiver is also written to app.audit_logs
-- (target_table ai_subscriptions), which keeps the history; app.ai_subscriptions is already kept as
-- a financial record (apps/api/src/modules/account/retention-policy.ts).
--
-- The confirmation the law asks for is an email to the student (the 'ai-store-purchase-confirmation'
-- template, sent by the email dispatcher from the aiSubscription.purchaseConfirmed outbox event). A
-- student signed up without an email address (a member-ID account, 000141) cannot be emailed, so the
-- confirmation is kept here instead and shown in the app's AI subscription screen:
-- withdrawal_waiver_confirmation says which of the two the student got.
--
-- Nullable: purchases from app versions that do not send the acknowledgement, and every add-on bought
-- before this migration, record nothing. Either all five columns are set or none is.

SET ROLE studafy_admin;

ALTER TABLE app.ai_subscriptions
  ADD COLUMN withdrawal_waiver_purchase_ref text,
  ADD COLUMN withdrawal_waiver_acknowledged_at timestamptz,
  ADD COLUMN withdrawal_waiver_terms_version text,
  ADD COLUMN withdrawal_waiver_recorded_at timestamptz,
  ADD COLUMN withdrawal_waiver_confirmation text,
  ADD CONSTRAINT ck_ai_subscriptions_withdrawal_waiver CHECK (
    (
      withdrawal_waiver_purchase_ref IS NULL
      AND withdrawal_waiver_acknowledged_at IS NULL
      AND withdrawal_waiver_terms_version IS NULL
      AND withdrawal_waiver_recorded_at IS NULL
      AND withdrawal_waiver_confirmation IS NULL
    )
    OR (
      withdrawal_waiver_purchase_ref ~ '^(apple|google):[0-9a-f]{64}$'
      AND withdrawal_waiver_acknowledged_at IS NOT NULL
      AND withdrawal_waiver_terms_version ~ '^\d{4}-\d{2}-\d{2}$'
      AND withdrawal_waiver_recorded_at IS NOT NULL
      AND withdrawal_waiver_acknowledged_at <= withdrawal_waiver_recorded_at
      AND withdrawal_waiver_confirmation IN ('email', 'in_app')
    )
  );

COMMENT ON COLUMN app.ai_subscriptions.withdrawal_waiver_purchase_ref IS
  'The store purchase the withdrawal waiver columns describe: platform, colon, sha256 hex of its transaction id (000195).';
COMMENT ON COLUMN app.ai_subscriptions.withdrawal_waiver_acknowledged_at IS
  'When the student asked for the add-on to start now and acknowledged losing the 14-day right to withdraw, as the app reported it (never later than recorded_at) (000195).';
COMMENT ON COLUMN app.ai_subscriptions.withdrawal_waiver_terms_version IS
  'Last-updated date of the Terms of Service in force when the waiver was recorded (000195).';
COMMENT ON COLUMN app.ai_subscriptions.withdrawal_waiver_recorded_at IS
  'When the server recorded the waiver with the purchase (000195).';
COMMENT ON COLUMN app.ai_subscriptions.withdrawal_waiver_confirmation IS
  'How the waiver was confirmed to the student: email, or in_app for accounts without an email address (000195).';

RESET ROLE;

-- The confirmation email's delivery label (app.email_deliveries.template). Not used in this
-- transaction, which is what lets ADD VALUE run inside it.
ALTER TYPE app.email_template ADD VALUE IF NOT EXISTS 'ai-store-purchase-confirmation';
