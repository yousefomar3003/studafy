-- studafy:migration transaction=off
-- Refresh-token rows that still hold an IP address, by school and age, for the daily IP-address
-- retention sweep (apps/workers/src/queues/maintenance/ip-address-retention-sweep.ts).
--
-- The sweep sets app.refresh_tokens.ip_address to NULL once a row is 90 days old, per school, 1000
-- rows at a time. No existing index serves "this school's rows older than X that still have an IP":
-- every refresh_tokens index leads with (school_id, <something else>), so each batch would read the
-- school's whole session history, which only grows (rotation inserts a row per refresh and nothing
-- deletes them outside erasure). The partial predicate keeps the index to rows that still carry an
-- address -- at steady state, about the last 90 days -- and a row leaves it the moment the sweep
-- clears its address, so the index does not grow with history either.
--
-- No HOT regression: updates to rotated_at/revoked_at were already non-HOT (they appear in
-- idx_refresh_tokens_school_user_active's predicate), and nothing but the sweep updates ip_address.
-- Built concurrently so sign-in and refresh stay writable while it builds.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_refresh_tokens_school_ip_created
  ON app.refresh_tokens (school_id, created_at)
  WHERE ip_address IS NOT NULL;
