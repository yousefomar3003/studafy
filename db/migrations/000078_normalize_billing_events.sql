-- Normalizes app.billing_events into a processable webhook ledger (ST-132).
--
-- 000016 created this table to answer exactly one question -- "have we already recorded this event
-- id" -- and its columns are sized for that: provider, provider_event_id, event_type, payload. The
-- Stripe webhook processor asks three more, and none of them can be answered from a jsonb blob
-- without re-deriving provider-specific structure at query time:
--
--   1. "When did this event actually happen?"  Stripe does not guarantee delivery order, so a
--      transition must be applied on the provider's own `created` timestamp, never on receipt time.
--   2. "Which subscription does this concern?"  The processor re-folds a subscription's whole event
--      history to reach a permutation-invariant final state, which needs an indexed lookup by
--      subscription, ordered by effective time.
--   3. "Did processing succeed, and if not, why?"  A poison event must be inspectable and replayable
--      rather than silently dropped.
--
-- So those become real columns. `payload` stays, unchanged in meaning: the verbatim provider object,
-- kept for replay and audit only. The columns are the source of truth for querying; the JSON is the
-- source of truth for replay. Nothing is stored in both -- effective_at is extracted from the
-- envelope's `created` field, which the payload column never contained (payload holds
-- `event.data.object`, not the event envelope), so there is no second copy to drift.
--
-- What deliberately does NOT go here: any derived subscription state. Whether a school is currently
-- active lives on app.subscriptions and nowhere else. subscription_id is a correlation handle, not a
-- state cache -- this table is a log.
--
-- ## Append-only, or mutable per event?
--
-- Mutable per event. One row per (provider, provider_event_id), updated across retries.
--
-- 000016 called the table append-only, and for a table that only ever recorded "seen it" that was
-- both true and free. It stops being free the moment retries exist. The alternative -- a new row per
-- delivery attempt -- would need a second identity column, because (provider, provider_event_id)
-- could no longer be unique; and losing that unique constraint would take the dedupe guarantee with
-- it, since the constraint *is* the arbiter that makes concurrent redelivery safe (the same reason
-- app.notification_idempotency_keys and app.email_deliveries key their claims on a unique index
-- rather than on application logic). "Have we processed this event" would become an aggregate over
-- attempts instead of a lookup.
--
-- So attempt_count, status, processed_at and last_error are updated in place. DELETE remains
-- withheld: a deletable webhook ledger is not evidence of anything. The header of 000016 should be
-- read with this amendment in mind.
--
-- ## Partitioning: deliberately deferred
--
-- app.audit_logs (000018) and app.attendance_records (000020) partition monthly because their row
-- counts are driven by per-actor and per-student-per-schoolday events: one school of 1,000 students
-- writes ~180,000 attendance rows a year by itself.
--
-- billing_events is driven by *subscription* lifecycle. A school generates on the order of a dozen
-- provider events a year -- a renewal, the odd payment failure, a plan change -- plus one row per
-- AI add-on subscription per student per year. At 10,000 schools that is comfortably under 10^6
-- rows/year, which a single B-tree-indexed table serves without strain and which the retry poller
-- never scans anyway (its partial index covers only the unresolved tail).
--
-- Revisit if either becomes true: sustained growth past ~50M rows, or a retention policy that wants
-- to drop old events by month (partition DROP being the only cheap way to do that). Neither is the
-- case today, and partitioning now would add monthly partition maintenance -- see
-- docs/database/audit-log-partition-maintenance.md for what that costs -- to buy nothing.
--
-- ## RLS: still global-admin-scoped, and still for 000016's reason
--
-- 000016 argues the table cannot be tenant-isolated because a delivery is deduplicated by
-- (provider, provider_event_id) *before* its payload is understood well enough to attribute it to a
-- school. Adding subscription_id does not change that: the claim happens first and the attribution
-- second, both inside one transaction, and a row that fails attribution keeps subscription_id NULL
-- forever. A NOT NULL school_id -- which app.apply_tenant_isolation requires -- is therefore still
-- impossible.
--
-- ENABLE + FORCE RLS and the global_admin_only policy are kept unchanged, as is the full revoke from
-- studafy_app. This is stricter than the ST-132 ticket's suggested "INSERT/SELECT for the app role":
-- the runtime role gets nothing at all, and the processor runs under studafy_admin via the API's
-- withSystemTenantTx. Access depends on both the grant and the policy rather than either alone.
--
-- Depends on 000016 (the table), 000068 (app.subscriptions.stripe_subscription_id).

SET LOCAL ROLE studafy_admin;

-- Processing lifecycle. 'pending' is claimed-not-yet-processed, which is also the state a crashed
-- attempt is left in; 'failed' is retryable; 'dlq' is terminal until a human replays it.
CREATE TYPE app.billing_event_status AS ENUM ('pending', 'processed', 'failed', 'dlq');

-- Which of the two subscription tables subscription_id points into. A polymorphic reference rather
-- than two nullable foreign keys, because the two are mutually exclusive by construction and a pair
-- of FKs would need a CHECK to say so anyway. No foreign key: the referenced row can be deleted by a
-- school teardown while the ledger must survive it, the same correlation-handle trade
-- app.notification_dispatch_logs.event_id and app.email_deliveries.outbox_event_id already make.
CREATE TYPE app.billing_subscription_type AS ENUM ('school', 'ai');

ALTER TABLE app.billing_events
  ADD COLUMN effective_at timestamptz,
  ADD COLUMN received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN processed_at timestamptz,
  ADD COLUMN status app.billing_event_status NOT NULL DEFAULT 'pending',
  ADD COLUMN subscription_type app.billing_subscription_type,
  ADD COLUMN subscription_id uuid,
  ADD COLUMN attempt_count smallint NOT NULL DEFAULT 0,
  ADD COLUMN last_error text;

-- Backfill, then constrain. Two distinct populations exist in this table before ST-132:
--
--   * effective_at has no sensible historical value, because the pre-ST-132 processor never read the
--     event envelope. created_at (receipt time) is the closest honest approximation and is what
--     ordering would have used anyway, so it is used rather than inventing a timestamp.
--   * Every pre-existing row was written by that processor, which stored the *object* id
--     (`sub_...`, `in_...`) in provider_event_id instead of the event id (`evt_...`) -- see the
--     ST-132 ticket. Those rows cannot be replayed (their key does not identify an event) and must
--     not be folded into any subscription's history, so they are parked in 'dlq' with the reason
--     recorded. They stay readable; they are simply not live work.
UPDATE app.billing_events
SET effective_at = created_at,
    status = 'dlq',
    last_error = 'Parked by 000078: predates ST-132 and stores a provider object id in '
                 || 'provider_event_id rather than the provider event id, so it cannot be '
                 || 'deduplicated, ordered or replayed.',
    attempt_count = 1;

ALTER TABLE app.billing_events
  ALTER COLUMN effective_at SET NOT NULL;

ALTER TABLE app.billing_events
  -- processed_at is the evidence of success and exists exactly when the status claims it.
  ADD CONSTRAINT ck_billing_events_processed_at CHECK (
    (status = 'processed') = (processed_at IS NOT NULL)
  ),
  -- Symmetrically, a terminal-or-retryable failure must say why. Truncated by the caller before it
  -- arrives: a CHECK violation here would abort the transaction that is recording the failure,
  -- trading the whole diagnostic for the tail of an error string (the same reasoning
  -- ck_notification_dead_letters_error_message carries in 000074).
  ADD CONSTRAINT ck_billing_events_last_error CHECK (
    CASE
      WHEN status IN ('failed', 'dlq')
        THEN last_error IS NOT NULL AND last_error = btrim(last_error) AND last_error <> ''
             AND char_length(last_error) <= 2000
      ELSE last_error IS NULL
    END
  ),
  -- An event is either attributed to a subscription or it is not. Half an attribution would let a
  -- row claim a type it has no id for, which the fold query would silently read as "no history".
  --
  -- Note what is deliberately NOT asserted: that a 'processed' row is attributed. Some provider
  -- events sit above the subscription level entirely -- `customer.created` concerns a school, not
  -- any one subscription -- and are legitimately processed with subscription_id NULL. 'processed'
  -- means "we saw this and finished with it", which includes deciding it changed no subscription.
  ADD CONSTRAINT ck_billing_events_subscription_ref CHECK (
    (subscription_type IS NULL) = (subscription_id IS NULL)
  ),
  ADD CONSTRAINT ck_billing_events_attempt_count CHECK (attempt_count >= 0),
  ADD CONSTRAINT ck_billing_events_received_at CHECK (received_at >= created_at),
  ADD CONSTRAINT ck_billing_events_processed_after_received CHECK (
    processed_at IS NULL OR processed_at >= received_at
  );

-- app.ai_subscriptions gains the provider key its sibling has had since 000068.
--
-- Without it an AI subscription can only be recognised from Stripe metadata, which is a weaker key
-- in a way that matters: `customer.subscription.*` carries the metadata the Checkout session set,
-- but an invoice event carries the subscription id and need not carry the student's. So an AI
-- renewal would be attributable on some event types and not on others, and the ones it missed would
-- dead-letter for a reason that has nothing to do with the event being wrong.
--
-- Nullable, unlike its counterpart's usage pattern: the row is created when Checkout completes and
-- the provider subscription id is stamped on in the same transaction, but a row that predates this
-- migration has none and cannot be given one retroactively. UNIQUE so one provider subscription can
-- never be claimed by two students -- and, because a UNIQUE constraint is implemented as a unique
-- index, this is also the attribution lookup's index.
ALTER TABLE app.ai_subscriptions
  ADD COLUMN stripe_subscription_id text;

ALTER TABLE app.ai_subscriptions
  ADD CONSTRAINT uq_ai_subscriptions_stripe_subscription_id UNIQUE (stripe_subscription_id);

-- The dedupe lookup is hit on every webhook call and is already indexed:
-- uq_billing_events_provider_event_id (000016) is a UNIQUE *constraint*, which PostgreSQL implements
-- with a unique index on (provider, provider_event_id). Adding a second index on the same columns
-- would double the write cost of the hottest path here to buy nothing, so this migration adds none.

-- Two consumers, two shapes.
--
-- The convergence fold: "every processed event for this subscription, oldest effective time first".
-- Partial because an unattributed row has no history to belong to, which keeps the index to the rows
-- the fold can actually return. Also serves the support query ("show me this subscription's event
-- history"), which is the same scan.
CREATE INDEX idx_billing_events_subscription_effective
  ON app.billing_events (subscription_type, subscription_id, effective_at)
  WHERE subscription_id IS NOT NULL;

-- The retry/DLQ worker's poll: "what still needs work, oldest first". Partial, and that is the whole
-- point -- the overwhelming majority of rows reach 'processed' and are never polled again, so this
-- index stays proportional to the unresolved tail rather than to the table. Same reasoning as
-- idx_notification_idempotency_unresolved (000074).
CREATE INDEX idx_billing_events_unresolved
  ON app.billing_events (received_at)
  WHERE status IN ('pending', 'failed');

-- Grants and RLS are unchanged from 000016 and are restated here only as the assertion that this
-- migration considered them: studafy_app holds no privilege on this table, PUBLIC holds none, RLS is
-- enabled and forced, and global_admin_only remains the single policy. The new enum types follow the
-- same posture -- studafy_app cannot name a type belonging to a table it cannot reach.
REVOKE ALL ON TYPE app.billing_event_status, app.billing_subscription_type FROM PUBLIC;

COMMENT ON TABLE app.billing_events IS
  'Payment-provider webhook ledger. One row per (provider, provider_event_id), mutable across retries. A log, never a state table.';
COMMENT ON COLUMN app.billing_events.effective_at IS
  'The provider''s own event timestamp. Transitions order on this, never on received_at -- delivery order is not guaranteed.';
COMMENT ON COLUMN app.billing_events.payload IS
  'The verbatim provider object, for replay and audit only. Never queried for values that exist as columns.';
COMMENT ON COLUMN app.billing_events.subscription_id IS
  'Correlation handle into app.subscriptions or app.ai_subscriptions per subscription_type. NULL until the event is attributed; never a foreign key.';

RESET ROLE;
