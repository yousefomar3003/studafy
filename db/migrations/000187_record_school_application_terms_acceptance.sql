-- Record a school applicant's acceptance of the Terms of Service and the School Agreement.
--
-- Until now a school applied and was approved without agreeing to any terms, so nothing bound the
-- school to the data-processing terms Studafy relies on as its processor. The application form now
-- requires the applicant to accept both documents; the row keeps which versions (the documents'
-- `Last updated` dates, packages/constants/src/legal.ts) and when, as proof of the agreement.
--
-- Nullable: applications submitted before this change have no acceptance. The check keeps the three
-- columns together, and the versions in the documents' date format.

SET ROLE studafy_admin;

ALTER TABLE app.school_applications
  ADD COLUMN terms_version text,
  ADD COLUMN school_agreement_version text,
  ADD COLUMN terms_accepted_at timestamptz,
  ADD CONSTRAINT ck_school_applications_terms_acceptance CHECK (
    (terms_version IS NULL AND school_agreement_version IS NULL AND terms_accepted_at IS NULL)
    OR (
      terms_version ~ '^\d{4}-\d{2}-\d{2}$'
      AND school_agreement_version ~ '^\d{4}-\d{2}-\d{2}$'
      AND terms_accepted_at IS NOT NULL
    )
  );

COMMENT ON COLUMN app.school_applications.terms_version IS
  'Last-updated date of the Terms of Service the applicant accepted.';
COMMENT ON COLUMN app.school_applications.school_agreement_version IS
  'Last-updated date of the School Agreement (including its data-processing terms) the applicant accepted.';
COMMENT ON COLUMN app.school_applications.terms_accepted_at IS
  'When the applicant accepted both documents (the submission time).';

RESET ROLE;
