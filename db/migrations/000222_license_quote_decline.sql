-- A school can decline a licence quote.
--
-- Until now a sent quote could only be accepted by the school, or withdrawn by the super admin; a
-- school that did not want it could only let it expire. A school's licence manager may now decline a
-- sent quote, with an optional reason the super admin reads. A declined quote is closed like an
-- expired or withdrawn one: it can no longer be accepted, and the super admin prices a new one.
--
-- Overlap credits are claimed by invoices, never by quotes (000165), so declining releases nothing.
--
--   * app.license_quotes.status          -- gains 'declined'.
--   * app.license_quotes.declined_at/by  -- when and by whom (a school user).
--   * app.license_quotes.decline_reason  -- optional, trimmed, at most 1000 characters.
--
-- Depends on 000165 (licence billing).

SET ROLE studafy_admin;

ALTER TABLE app.license_quotes
  ADD COLUMN declined_at timestamptz,
  ADD COLUMN declined_by uuid,
  ADD COLUMN decline_reason text;

ALTER TABLE app.license_quotes
  DROP CONSTRAINT ck_license_quotes_status,
  DROP CONSTRAINT ck_license_quotes_closed;

ALTER TABLE app.license_quotes
  ADD CONSTRAINT ck_license_quotes_status CHECK (
    status IN ('draft', 'sent', 'accepted', 'expired', 'withdrawn', 'declined')
  ),
  ADD CONSTRAINT ck_license_quotes_closed CHECK (
    (status IN ('expired', 'withdrawn', 'declined')) = (closed_at IS NOT NULL)
  ),
  ADD CONSTRAINT ck_license_quotes_declined CHECK (
    (status = 'declined') = (declined_at IS NOT NULL)
    AND (declined_at IS NULL) = (declined_by IS NULL)
    AND (
      decline_reason IS NULL
      OR (
        status = 'declined'
        AND decline_reason = btrim(decline_reason)
        AND decline_reason <> ''
        AND char_length(decline_reason) <= 1000
      )
    )
  );

COMMENT ON COLUMN app.license_quotes.declined_at IS
  'When the school declined this quote (status declined, 000222).';
COMMENT ON COLUMN app.license_quotes.declined_by IS
  'The school user who declined this quote (000222).';
COMMENT ON COLUMN app.license_quotes.decline_reason IS
  'The school''s optional reason for declining, shown to the super admin (000222).';

RESET ROLE;
