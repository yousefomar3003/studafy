-- App-store purchases of the AI add-on (apps/api modules/subscriptions/store). Apple's and Google's
-- server notifications name a subscription only by the store's own reference -- Apple's
-- originalTransactionId, Google's purchase token -- and arrive with no tenant context. The first
-- purchase, reported by the signed-in student's app, is recorded in app.billing_events with that
-- reference and the school and student it belongs to; every later notification is attributed by
-- looking the reference up here, and a reference already claimed by another student is refused.
-- Partial: only store events carry a store_ref, so the index stays the size of the store traffic.

SET ROLE studafy_admin;

CREATE INDEX idx_billing_events_store_ref
  ON app.billing_events (provider, (payload ->> 'store_ref'), effective_at DESC)
  WHERE provider IN ('apple', 'google');

RESET ROLE;
