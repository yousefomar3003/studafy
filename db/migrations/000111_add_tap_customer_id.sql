-- Tap Payments customer id per school (ST-298).
--
-- Schools in Tap's MENA regions are billed through Tap rather than Stripe. Each provider keeps its
-- own customer object, so each gets its own column rather than stripe_customer_id being reused:
-- Tap and Stripe both mint ids shaped `cus_...`, and a shared column would let an event from one
-- provider be attributed through a customer created at the other.
--
-- Same shape as 000068's stripe_customer_id, and for the same reason it lives on app.schools:
-- webhook attribution resolves the school *before* any tenant scope exists, and app.schools is one
-- of the global, non-RLS tables that lookup may read (see packages/billing/src/attribution.ts).
--
-- UNIQUE because the column is an attribution key: two schools sharing one Tap customer would make
-- every event for that customer ambiguous. NULL until the school's first Tap checkout.

SET ROLE studafy_admin;

ALTER TABLE app.schools
  ADD COLUMN tap_customer_id text;

ALTER TABLE app.schools
  ADD CONSTRAINT uq_schools_tap_customer_id UNIQUE (tap_customer_id);

RESET ROLE;
