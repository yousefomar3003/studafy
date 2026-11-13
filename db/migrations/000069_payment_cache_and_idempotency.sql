-- ST-121: gateway-originated payments and the durable idempotency guard that keeps them exactly-once.
--
-- Two changes, one purpose. Until now every row in app.payment_cache arrived *from* ERPNext, via the
-- webhook receiver, describing a Payment Entry that already existed. ST-121 adds the other
-- direction: Studafy forwards a payment it collected (cash at the office, a bank transfer, a card
-- captured externally) to ERPNext as a Payment Entry. A row can now exist in this cache *before*
-- ERPNext has confirmed submission, so the cache needs a lifecycle it never needed before, and the
-- forwarder needs a guard that survives a crash between "posted to ERPNext" and "recorded locally".
--
-- What this migration deliberately does NOT do:
--
--   * It does not add a decimal `amount` or a `currency` text column. The ticket asks for
--     numeric(12,3) and varchar(3); this schema keeps amount_minor bigint + currency_id uuid, the
--     convention 000015 set and apps/api/src/modules/finance/currency.ts exists to serve. JOD is
--     seeded in 000005 with minor_unit = 3 -- numeric(12,3) would hardcode that exponent into the
--     schema, and every non-JOD currency would then be silently wrong. app.currencies already knows
--     the right answer per currency.
--   * It does not add an `erpnext_payment_entry_id` column. erpnext_docname *is* the Payment Entry
--     name; a second column holding the same string is a second thing to keep in sync.
--   * It does not model which invoice a payment ultimately settled. ERPNext allocates a Payment
--     Entry across invoices and that allocation is its answer to give, per 000015's header.
--     erpnext_invoice_id below records the *requested target* -- the input we sent -- not a derived
--     allocation, and is therefore not a local ledger.
--
-- Depends on 000015 (app.payment_cache and its tenant_isolation policy), 000004 (app.schools) and
-- 000006 (app.apply_tenant_isolation).

-- Required before SET ROLE: the backfill below reads and writes app.payment_cache, whose
-- tenant_isolation policy is FORCED and therefore binds studafy_admin too. Without a resolvable
-- app.school_id, current_setting('app.school_id')::uuid raises rather than filtering. The sentinel
-- matches no real tenant; the DO block sets each real one in turn.
SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------
-- 1. app.payment_cache gains a lifecycle
-- ---------------------------------------------------------------------------

ALTER TABLE app.payment_cache
  -- The Sales Invoice this payment was posted against, as sent to ERPNext. Nullable because a
  -- webhook-projected payment Studafy did not originate carries no request of ours to remember.
  ADD COLUMN erpnext_invoice_id text,
  -- How the money was collected. Nullable for the same reason: ERPNext's Mode of Payment is a
  -- free-form document name, and only a payment this gateway forwarded is known to be one of ours.
  ADD COLUMN payment_mode       text,
  -- 'pending' until ERPNext's webhook confirms submission; the SLA in ST-121 is measured on that
  -- transition. DEFAULT keeps every existing INSERT site (including 000015's own fixtures) working.
  ADD COLUMN status             text NOT NULL DEFAULT 'pending',
  -- The ERPNext-generated receipt link. Stored as a plain path/URL and never a signed or
  -- credential-bearing one, so this column can be handed to a client as-is.
  ADD COLUMN receipt_url        text,
  -- Kept for traceability from a cached payment back to the request that created it. The guard
  -- itself lives in payment_idempotency_logs; this is not that guard and carries no unique index.
  ADD COLUMN idempotency_key    varchar(255),
  ADD COLUMN confirmed_at       timestamptz;

-- Rows that predate this migration all arrived from the webhook, meaning ERPNext had already
-- submitted them. Leaving them at the 'pending' default would misreport settled money as in-flight.
-- last_synced_at is when we learned of the submission and is the closest honest confirmation time.
--
-- Per-school loop rather than one UPDATE: tenant_isolation is FORCED on app.payment_cache, so a
-- single statement under the sentinel context above would match zero rows and silently no-op.
-- Same shape as 000065's backfill.
DO $backfill$
DECLARE
  target_school_id uuid;
BEGIN
  FOR target_school_id IN SELECT id FROM app.schools LOOP
    PERFORM set_config('app.school_id', target_school_id::text, true);

    -- GREATEST, not last_synced_at alone: the webhook receiver computes its `now` in JavaScript and
    -- passes it as last_synced_at, while created_at defaults to the server's CURRENT_TIMESTAMP
    -- evaluated a round-trip later. Existing rows can therefore carry last_synced_at marginally
    -- *before* created_at, which ck_payment_cache_confirmed_after_created below would reject.
    UPDATE app.payment_cache
    SET status = 'confirmed',
        confirmed_at = GREATEST(last_synced_at, created_at),
        updated_at = CURRENT_TIMESTAMP
    WHERE confirmed_at IS NULL;
  END LOOP;

  PERFORM set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);
END
$backfill$;

-- Constraints added after the backfill, so they validate data already made consistent.
--
-- text + CHECK rather than CREATE TYPE: this follows app.expense_cache (000064), the most recent
-- sibling, rather than 000015's enums. An enum would need its own GRANT USAGE ON TYPE to maintain,
-- and adding a fourth payment mode would need a non-transactional ALTER TYPE migration (see 000063)
-- where this needs only a constraint swap.
ALTER TABLE app.payment_cache
  ADD CONSTRAINT ck_payment_cache_payment_mode CHECK (
    payment_mode IS NULL OR payment_mode IN ('cash', 'bank_transfer', 'card_external')
  ),
  ADD CONSTRAINT ck_payment_cache_status CHECK (
    status IN ('pending', 'confirmed', 'failed')
  ),
  -- Biconditional, not two one-way checks: a confirmed payment without a timestamp and a timestamped
  -- payment still reading 'pending' are both incoherent. Same idiom as 000015's
  -- ck_finance_sync_outbox_processed_state.
  ADD CONSTRAINT ck_payment_cache_confirmed_state CHECK (
    (status = 'confirmed') = (confirmed_at IS NOT NULL)
  ),
  ADD CONSTRAINT ck_payment_cache_confirmed_after_created CHECK (
    confirmed_at IS NULL OR confirmed_at >= created_at
  ),
  ADD CONSTRAINT ck_payment_cache_erpnext_invoice_id CHECK (
    erpnext_invoice_id IS NULL
    OR (erpnext_invoice_id = btrim(erpnext_invoice_id) AND erpnext_invoice_id <> '')
  ),
  ADD CONSTRAINT ck_payment_cache_idempotency_key CHECK (
    idempotency_key IS NULL
    OR (idempotency_key = btrim(idempotency_key) AND idempotency_key <> '')
  );

-- ---------------------------------------------------------------------------
-- 2. app.payment_idempotency_logs -- the durable exactly-once guard
-- ---------------------------------------------------------------------------

-- Why this exists when apps/api/src/middleware/idempotency.ts already replays responses for
-- /api/finance/*: that middleware is Redis-backed and fails *open*. When Redis is cold, evicted, or
-- unreachable, it waves the request through, and on a payment path "waved through" means a second
-- Payment Entry and a double charge. Response replay is a latency optimisation; this table is the
-- correctness guarantee, and it is checked inside the same tenant transaction as the forward.
--
-- request_hash is the SHA-256 of the canonical request body. It is what distinguishes "the client
-- retried" from "the client reused a key for different money" -- the latter must be refused, not
-- answered from cache.
CREATE TABLE app.payment_idempotency_logs (
  id uuid DEFAULT gen_random_uuid()
    CONSTRAINT pk_payment_idempotency_logs PRIMARY KEY,
  school_id                uuid NOT NULL,
  idempotency_key          varchar(255) NOT NULL,
  -- Nullable by design, and the reason this guard is crash-safe rather than merely fast. The row is
  -- INSERTed (reserving the key) *before* the ERPNext POST and filled in after, so a process that
  -- dies mid-post leaves evidence that the outcome is unknown. A retry then finds a reserved row
  -- with no entry id and is refused rather than re-posting. 000015 documents this same
  -- reserve-then-confirm shape for erpnext_id_mappings.erpnext_docname.
  erpnext_payment_entry_id text,
  request_hash             varchar(64) NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_payment_idempotency_logs_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT ck_payment_idempotency_logs_key CHECK (
    idempotency_key = btrim(idempotency_key) AND idempotency_key <> ''
  ),

  CONSTRAINT ck_payment_idempotency_logs_entry_id CHECK (
    erpnext_payment_entry_id IS NULL
    OR (
      erpnext_payment_entry_id = btrim(erpnext_payment_entry_id)
      AND erpnext_payment_entry_id <> ''
    )
  ),

  -- Lowercase hex SHA-256. Constrained rather than left as free text so a malformed hash cannot be
  -- stored and then silently fail to match a legitimate retry.
  CONSTRAINT ck_payment_idempotency_logs_request_hash CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  )
);

-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------

-- The guard itself. Tenant-scoped, so two schools may independently use the same key -- a client's
-- key namespace is its own, and a global unique index would leak one tenant's key choices into
-- another's failures.
CREATE UNIQUE INDEX idx_payment_idempotency_unique
  ON app.payment_idempotency_logs (school_id, idempotency_key);

-- "What has this student paid against this invoice?" Partial: a webhook-projected payment has no
-- requested target, and indexing those NULLs would only grow the index.
CREATE INDEX idx_payment_cache_invoice_student
  ON app.payment_cache (school_id, erpnext_invoice_id, student_id)
  WHERE erpnext_invoice_id IS NOT NULL;

-- Reconciliation: the pending payments for a tenant, newest first. created_at DESC matches the scan
-- direction the reconciliation query actually uses.
CREATE INDEX idx_payment_cache_status
  ON app.payment_cache (school_id, status, created_at DESC);

-- ST-121 also asks for a "fast webhook match index on Payment Entry ID". Deliberately not created:
-- 000015's uq_payment_cache_school_erpnext_docname is already a unique index on
-- (school_id, erpnext_docname), which is exactly the lookup the webhook performs. A second index
-- over the same columns is write amplification on every payment for no additional read path.

-- ---------------------------------------------------------------------------
-- 4. Grants and RLS
-- ---------------------------------------------------------------------------

-- studafy_app is revoked explicitly alongside PUBLIC, not folded into it: 000002 sets ALTER DEFAULT
-- PRIVILEGES granting studafy_app full DML on every table studafy_admin creates in app, so revoking
-- from PUBLIC alone would leave those defaults standing and make the GRANT below decorative.
--
-- DELETE is granted, unusually for a log-shaped table, and only for one purpose: when ERPNext
-- refuses a payload with a 4xx it has rendered a verdict, no Payment Entry exists, and the
-- reservation must be released so the caller can correct the body and retry under the same key.
-- Every other failure mode retains the row.
REVOKE ALL PRIVILEGES ON TABLE app.payment_idempotency_logs FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.payment_idempotency_logs TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'payment_idempotency_logs');

-- app.payment_cache already carries tenant_isolation from 000015. apply_tenant_isolation is not
-- re-run for it: the policy covers the table, not its column list, so new columns are already
-- governed by the predicate that was installed with the table.

RESET ROLE;
