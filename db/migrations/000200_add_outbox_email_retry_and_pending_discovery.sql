-- Outbox consumer polling cost (compute-cost cleanup C1): email retry backoff, the 000077 email
-- index's retirement, and one-statement pending-school discovery for the three polling consumers.
--
-- ## 1. Email retry state on the outbox row
--
-- A transient send failure (provider throttling, 5xx, network) used to roll the dispatcher's
-- transaction back and leave the row exactly as it was, so the next cycle -- one second later --
-- tried it again, forever, and a row that never succeeded was retried ~86 000 times a day.
-- email_attempts counts those failures and email_next_attempt_at holds the row back until its next
-- try (the dispatcher doubles the wait from 30 s up to 1 h). The claim skips a row until then, so a
-- failing message never blocks the school's later ones, and after 10 attempts the dispatcher
-- dead-letters it: a 'failed' email_deliveries row with the last error, and email_dispatched_at set.
--
-- On the outbox row rather than on email_deliveries because a delivery row is the dedup arbiter
-- (uq_email_deliveries_event_recipient): committing one for an attempt that did not land would make
-- the next attempt look like a duplicate and skip the send.
--
-- ADD COLUMN with a constant default is metadata-only, so no rewrite. The CHECK is NOT VALID: every
-- existing row carries the default 0, which satisfies it, and validating would scan the whole
-- (never-reaped) outbox under this migration's ACCESS EXCLUSIVE lock. It is enforced for every
-- write from here on.
--
-- ## 2. Retire idx_outbox_events_school_email_pending (000077)
--
-- Superseded by 000199's idx_outbox_events_school_email_claim, whose predicate names the email
-- events. The old one indexed every outbox row ever written that is not an email (see 000199).
-- A plain DROP INDEX: this migration already takes the table's ACCESS EXCLUSIVE lock for the ALTER
-- above, both are catalog-only, and lock_timeout bounds how long either may queue behind a
-- long-running transaction (holding writes behind it) before the migration fails and can be re-run.
--
-- ## 3. app.outbox_pending_school_ids(consumer)
--
-- The relay, the entitlement invalidator and the email dispatcher each ran one transaction per
-- school every 0.5-1 s just to find out that school had nothing to do: about 24 statements a second
-- per school, plus 17, on an idle system. They now ask this function once per cycle and open a
-- claim transaction only for the schools it names.
--
-- app.outbox_events is FORCE ROW LEVEL SECURITY under the canonical tenant policy, and this schema
-- deliberately has no cross-tenant read path into it (ADR-015). The function therefore does not add
-- one: it walks app.schools (global, no RLS) and, for each school, arms app.school_id for that
-- school and runs an EXISTS against the consumer's partial index -- exactly the scoping a per-school
-- withSystemTenantTx gives the claim, batched into one statement. Each probe is an index-only touch
-- of a partial index that holds only pending rows, so an idle call costs about one index descent per
-- school. Every predicate repeats the consumer's claim predicate (and so its index predicate)
-- verbatim, which is what lets the planner use those partial indexes.
--
-- SECURITY INVOKER, search_path pinned, executable only by studafy_admin (the same posture as
-- app.apply_tenant_isolation): it grants nothing the caller could not already do one school at a
-- time, and the workers call it under withSystemTx. app.school_id is restored before returning; it
-- is transaction-local in any case.
--
-- The email predicate's event list must stay in step with 000199's index and with
-- EMAIL_EVENT_NAMES (apps/workers/src/queues/notifications/email/resolve.ts); the entitlement lists
-- with 000080 / 000162 and apps/workers/src/queues/entitlements/claim.ts.

SET LOCAL ROLE studafy_admin;
SET LOCAL lock_timeout = '5s';

-- 1 -------------------------------------------------------------------------------------------------

ALTER TABLE app.outbox_events
  ADD COLUMN email_attempts smallint NOT NULL DEFAULT 0,
  ADD COLUMN email_next_attempt_at timestamptz;

ALTER TABLE app.outbox_events
  ADD CONSTRAINT ck_outbox_events_email_attempts
  CHECK (email_attempts >= 0 AND email_attempts <= 10) NOT VALID;

COMMENT ON COLUMN app.outbox_events.email_attempts IS
  'Transient email send failures so far. The dispatcher dead-letters the row at 10.';
COMMENT ON COLUMN app.outbox_events.email_next_attempt_at IS
  'Earliest time the email dispatcher may retry this row after a transient failure; NULL = now.';

-- 2 -------------------------------------------------------------------------------------------------

DROP INDEX app.idx_outbox_events_school_email_pending;

-- 3 -------------------------------------------------------------------------------------------------

CREATE FUNCTION app.outbox_pending_school_ids(p_consumer text)
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  previous_school text := pg_catalog.current_setting('app.school_id', true);
  candidate uuid;
  pending boolean;
BEGIN
  IF p_consumer IS NULL OR p_consumer NOT IN ('relay', 'email', 'entitlement') THEN
    RAISE EXCEPTION 'unknown outbox consumer %', p_consumer USING ERRCODE = '22023';
  END IF;

  FOR candidate IN SELECT school.id FROM app.schools AS school ORDER BY school.id LOOP
    PERFORM pg_catalog.set_config('app.school_id', candidate::text, true);

    IF p_consumer = 'relay' THEN
      -- idx_outbox_events_school_unrelayed (000022)
      pending := EXISTS (
        SELECT 1 FROM app.outbox_events AS event
        WHERE event.school_id = candidate AND event.relayed_at IS NULL
      );
    ELSIF p_consumer = 'email' THEN
      -- idx_outbox_events_school_email_claim (000199)
      pending := EXISTS (
        SELECT 1 FROM app.outbox_events AS event
        WHERE event.school_id = candidate
          AND event.email_dispatched_at IS NULL
          AND event.event_name IN (
            'invitation.sent',
            'school.verificationEmailSent',
            'digest.sent',
            'notification.digestSent',
            'subscription.dunningSent',
            'subscription.seatDriftReported',
            'aiSubscription.paused',
            'aiSubscription.resumed',
            'account.deletionRequested',
            'account.deleted',
            'aiSubscription.purchaseConfirmed'
          )
          AND (event.email_next_attempt_at IS NULL
               OR event.email_next_attempt_at <= CURRENT_TIMESTAMP)
      );
    ELSE
      -- idx_outbox_events_school_entitlement_pending (000080) and
      -- idx_outbox_events_school_user_entitlement_pending (000162)
      pending := EXISTS (
        SELECT 1 FROM app.outbox_events AS event
        WHERE event.school_id = candidate
          AND event.entitlement_applied_at IS NULL
          AND event.event_name IN ('subscription.statusChanged', 'aiSubscription.statusChanged')
      ) OR EXISTS (
        SELECT 1 FROM app.outbox_events AS event
        WHERE event.school_id = candidate
          AND event.entitlement_applied_at IS NULL
          AND event.event_name = 'userEntitlement.changed'
      );
    END IF;

    IF pending THEN
      RETURN NEXT candidate;
    END IF;
  END LOOP;

  PERFORM pg_catalog.set_config('app.school_id', COALESCE(previous_school, ''), true);
  RETURN;
END
$function$;

ALTER FUNCTION app.outbox_pending_school_ids(text) OWNER TO studafy_admin;
REVOKE ALL ON FUNCTION app.outbox_pending_school_ids(text) FROM PUBLIC, studafy_app;
GRANT EXECUTE ON FUNCTION app.outbox_pending_school_ids(text) TO studafy_admin;

COMMENT ON FUNCTION app.outbox_pending_school_ids(text) IS
  'Schools with outbox rows pending for one consumer (relay | email | entitlement), probed one tenant at a time under the canonical tenant policy.';

RESET ROLE;
