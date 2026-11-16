-- An online payment link on a licence invoice.
--
-- The super admin pastes a payment link made in the provider's own dashboard (today Revolut) onto an
-- invoice; the school sees a "Pay online" button beside the bank details while the invoice is
-- unpaid. Studafy does not talk to the provider: the super admin still records each payment by hand
-- (app.license_payments), exactly as for a bank transfer, and the license activates as before.
--
-- The API admits only https links to the hosts in @studafy/constants LICENSE_PAYMENT_LINK_HOSTS;
-- the CHECK below is the database's own floor (https, no whitespace, at most 500 characters, the
-- same limit as LICENSE_PAYMENT_LINK_MAX_LENGTH).

SET ROLE studafy_admin;

ALTER TABLE app.license_invoices
  ADD COLUMN payment_link text;

ALTER TABLE app.license_invoices
  ADD CONSTRAINT ck_license_invoices_payment_link CHECK (
    payment_link IS NULL
    OR (payment_link ~ '^https://[^[:space:]]+$' AND char_length(payment_link) <= 500)
  );

COMMENT ON COLUMN app.license_invoices.payment_link IS
  'An online payment link (Revolut) the super admin pasted; shown to the school as "Pay online" while the invoice is unpaid. Payments are still recorded by hand (000220).';

RESET ROLE;
