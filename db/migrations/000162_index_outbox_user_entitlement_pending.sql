-- studafy:migration transaction=off
-- The entitlement invalidator's claim path for userEntitlement.changed (000161, feature licensing).
--
-- idx_outbox_events_school_entitlement_pending (000080) names its two event names in its predicate,
-- so a third event needs an index of its own. A sibling partial index is added rather than that one
-- rebuilt with three names: the outbox is never reaped, and rebuilding the existing index would
-- briefly leave the school and AI claims without one. Built concurrently so the outbox -- written
-- inside every webhook and every audited mutation -- stays writable while it builds.
--
-- apps/workers/src/queues/entitlements/claim.ts repeats this predicate verbatim in its user claim.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_events_school_user_entitlement_pending
  ON app.outbox_events (school_id, id)
  WHERE entitlement_applied_at IS NULL
    AND event_name = 'userEntitlement.changed';
