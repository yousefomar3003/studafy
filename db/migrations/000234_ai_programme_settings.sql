-- The Student AI programme's settings, versioned: phase 1 of "Student AI seats bundled with tuition,
-- plus revenue share" (approved 2026-11-17; docs/billing/ai-programme.md).
--
-- Schools can add Student AI for their students, bundled with tuition, and Studafy pays the school a
-- revenue share. Every number in that programme is the super admin's to change -- prices, minimum
-- seats, the share tiers, the cap, the bonus, the measurement date, the grace period, the rules for
-- month-to-month licences and how the share is paid -- globally or per school, and licences keep the
-- values they were signed with.
--
-- ## Versions
--
-- Settings are never edited in place. Each save is a new, immutable version, with who saved it, when
-- and why (and an audit row):
--
--   * app.ai_programme_versions          -- global, admin-written: every scalar setting.
--   * app.ai_programme_version_prices    -- global: the in-app purchase, school licence (per seat per
--                                           month) and parent (per month) prices per currency.
--   * app.ai_programme_version_tiers     -- global: the conversion tiers (conversion from -> share)
--                                           and content-bonus tiers (upload consistency from -> bonus).
--   * app.ai_programme_school_overrides  -- per school: any subset of the scalar settings and the two
--                                           prices (in the currency they were set in); NULL inherits.
--                                           Clearing a school's overrides is a new, empty version.
--   * app.ai_programme_school_override_tiers -- per school: a tier table the school overrides
--                                           (no rows of a kind: the global tiers of that kind).
--
-- The school's override wins wherever it sets a value (@studafy/license-pricing resolveAiProgramme).
-- The in-app purchase price has no override: a store price is the same everywhere. Money is bigint
-- minor units of the price's currency; percentages are basis points (10000 = 100%).
--
-- The first global version is the approved defaults, in USD: $5.99 in-app (reference), $4 licence,
-- $4 parents (the school-offer price: schools tell parents; the app never shows it),
-- minimum 30 seats, maximum share 15%, conversion 0/4/6/8/10/12% from 0/25/40/55/70/85%, 500+ seats at
-- least 8%, bonus +0/+1.5/+3% from 0/60/80% upload consistency and only above a 0% conversion share,
-- measured 30 days after the licence starts, 30 days' grace, month-to-month licences 0% of the tier
-- values, the share as a credit on the next invoice. It has a fixed id, so the columns below can be
-- backfilled with it.
--
-- ## Licences and quotes keep the values they were signed with
--
--   * app.license_quotes.ai_programme_version_id / ai_programme_override_id -- the global version and
--     the school's override version in force when the quote was priced (NULL: priced before 000234).
--   * app.school_licenses.ai_programme_version_id / ai_programme_override_id -- what the licence was
--     signed with: set from the accepted quote for a new licence or an extension (a renewal), kept
--     through a seat increase, and replaced only when the super admin re-applies the current values
--     (with a reason, audited). Existing licences get the first version: the defaults, which are the
--     rules they already ran on.
--   * app.school_licenses.ai_programme_applied_at -- when those values were attached.
--   * app.school_licenses.nonpayment_grace_days  -- the resolved grace period, kept on the licence so
--     the workers' AI-stop SQL (000233) reads it without resolving settings. Written together with the
--     two version ids; replaces the fixed 30 days of LICENSE_NONPAYMENT_GRACE_DAYS.
--
-- ## Tenancy
--
-- The global tables have no school_id and are approved globals in db/policies/rls-coverage.ts. The
-- override tables carry school_id, the canonical tenant policy and school-leading keys; the tier
-- table's composite key reaches its override through (override_id, school_id). The runtime role
-- (studafy_app) may read all five -- a school accepting a quote resolves its own values -- and write
-- none: only the super admin's console (studafy_admin) saves versions. Every version table rejects
-- UPDATE and DELETE by trigger, whoever asks.
--
-- Depends on 000004 (currencies, schools), 000163 (licences), 000165 (quotes), 000233 (grace period).

-- The FK validation scans below read app.school_licenses and app.license_quotes, which force RLS: a
-- non-matching tenant context lets them run (as in 000168 and 000233).
SELECT set_config('app.school_id', '00000000-0000-0000-0000-000000000000', true);

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. Global versions
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.ai_programme_versions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ai_programme_versions PRIMARY KEY,
  version_number integer NOT NULL CONSTRAINT uq_ai_programme_versions_number UNIQUE,
  min_seats integer NOT NULL,
  max_share_bps integer NOT NULL,
  large_school_min_seats integer NOT NULL,
  -- 0 turns the floor off.
  large_school_share_bps integer NOT NULL,
  bonus_requires_conversion_share boolean NOT NULL,
  measurement_offset_days integer NOT NULL,
  nonpayment_grace_days integer NOT NULL,
  -- The share a month-to-month licence earns, as basis points of the tier values (5000: half).
  month_to_month_share_bps integer NOT NULL,
  payout_mode text NOT NULL,
  reason text NOT NULL,
  -- The super admin, a user of their own home school (no FK, as in 000163), and that school, so the
  -- console can show their name; both NULL for the defaults this migration seeds.
  created_by uuid,
  created_by_school_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_ai_programme_versions_number CHECK (version_number >= 1),
  CONSTRAINT ck_ai_programme_versions_min_seats CHECK (min_seats BETWEEN 1 AND 100000),
  CONSTRAINT ck_ai_programme_versions_max_share CHECK (max_share_bps BETWEEN 0 AND 10000),
  CONSTRAINT ck_ai_programme_versions_large_school CHECK (
    large_school_min_seats BETWEEN 1 AND 1000000
    AND large_school_share_bps BETWEEN 0 AND max_share_bps
  ),
  CONSTRAINT ck_ai_programme_versions_measurement CHECK (measurement_offset_days BETWEEN 0 AND 365),
  CONSTRAINT ck_ai_programme_versions_grace CHECK (nonpayment_grace_days BETWEEN 1 AND 365),
  CONSTRAINT ck_ai_programme_versions_month_to_month CHECK (
    month_to_month_share_bps BETWEEN 0 AND 10000
  ),
  CONSTRAINT ck_ai_programme_versions_payout_mode CHECK (payout_mode IN ('invoice_credit', 'payout')),
  CONSTRAINT ck_ai_programme_versions_reason CHECK (
    reason = btrim(reason) AND reason <> '' AND char_length(reason) <= 1000
  ),
  CONSTRAINT ck_ai_programme_versions_created_by CHECK (
    (created_by IS NULL) = (created_by_school_id IS NULL)
    AND (created_by IS NOT NULL OR version_number = 1)
  )
);

CREATE TABLE app.ai_programme_version_prices (
  version_id uuid NOT NULL,
  currency_id uuid NOT NULL,
  iap_price_minor bigint NOT NULL,
  license_price_minor bigint NOT NULL,
  parent_price_minor bigint NOT NULL,
  CONSTRAINT pk_ai_programme_version_prices PRIMARY KEY (version_id, currency_id),
  CONSTRAINT fk_ai_programme_version_prices_version FOREIGN KEY (version_id)
    REFERENCES app.ai_programme_versions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_version_prices_currency FOREIGN KEY (currency_id)
    REFERENCES app.currencies (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_ai_programme_version_prices_amounts CHECK (
    iap_price_minor BETWEEN 0 AND 100000000
    AND license_price_minor BETWEEN 0 AND 100000000
    AND parent_price_minor BETWEEN 0 AND 100000000
  )
);

CREATE TABLE app.ai_programme_version_tiers (
  version_id uuid NOT NULL,
  -- conversion: students opted in / enrolled. content_bonus: upload consistency.
  kind text NOT NULL,
  from_bps integer NOT NULL,
  share_bps integer NOT NULL,
  CONSTRAINT pk_ai_programme_version_tiers PRIMARY KEY (version_id, kind, from_bps),
  CONSTRAINT fk_ai_programme_version_tiers_version FOREIGN KEY (version_id)
    REFERENCES app.ai_programme_versions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_ai_programme_version_tiers_kind CHECK (kind IN ('conversion', 'content_bonus')),
  CONSTRAINT ck_ai_programme_version_tiers_bps CHECK (
    from_bps BETWEEN 0 AND 10000 AND share_bps BETWEEN 0 AND 10000
  )
);

-- ---------------------------------------------------------------------------------------------------
-- 2. School overrides
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.ai_programme_school_overrides (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_ai_programme_school_overrides PRIMARY KEY,
  school_id uuid NOT NULL,
  version_number integer NOT NULL,
  -- The two prices, in this currency (the school's when they were set). Both NULL with it.
  price_currency_id uuid,
  license_price_minor bigint,
  parent_price_minor bigint,
  min_seats integer,
  max_share_bps integer,
  large_school_min_seats integer,
  large_school_share_bps integer,
  bonus_requires_conversion_share boolean,
  measurement_offset_days integer,
  nonpayment_grace_days integer,
  month_to_month_share_bps integer,
  payout_mode text,
  reason text NOT NULL,
  -- The super admin and their home school (see app.ai_programme_versions).
  created_by uuid NOT NULL,
  created_by_school_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_ai_programme_school_overrides_number UNIQUE (school_id, version_number),
  CONSTRAINT uq_ai_programme_school_overrides_id_school UNIQUE (id, school_id),
  CONSTRAINT fk_ai_programme_school_overrides_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_school_overrides_currency FOREIGN KEY (price_currency_id)
    REFERENCES app.currencies (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_ai_programme_school_overrides_number CHECK (version_number >= 1),
  CONSTRAINT ck_ai_programme_school_overrides_prices CHECK (
    (price_currency_id IS NULL) = (license_price_minor IS NULL AND parent_price_minor IS NULL)
    AND (license_price_minor IS NULL OR license_price_minor BETWEEN 0 AND 100000000)
    AND (parent_price_minor IS NULL OR parent_price_minor BETWEEN 0 AND 100000000)
  ),
  CONSTRAINT ck_ai_programme_school_overrides_values CHECK (
    (min_seats IS NULL OR min_seats BETWEEN 1 AND 100000)
    AND (max_share_bps IS NULL OR max_share_bps BETWEEN 0 AND 10000)
    AND (large_school_min_seats IS NULL OR large_school_min_seats BETWEEN 1 AND 1000000)
    AND (large_school_share_bps IS NULL OR large_school_share_bps BETWEEN 0 AND 10000)
    AND (measurement_offset_days IS NULL OR measurement_offset_days BETWEEN 0 AND 365)
    AND (nonpayment_grace_days IS NULL OR nonpayment_grace_days BETWEEN 1 AND 365)
    AND (month_to_month_share_bps IS NULL OR month_to_month_share_bps BETWEEN 0 AND 10000)
    AND (payout_mode IS NULL OR payout_mode IN ('invoice_credit', 'payout'))
  ),
  CONSTRAINT ck_ai_programme_school_overrides_reason CHECK (
    reason = btrim(reason) AND reason <> '' AND char_length(reason) <= 1000
  )
);

CREATE TABLE app.ai_programme_school_override_tiers (
  school_id uuid NOT NULL,
  override_id uuid NOT NULL,
  kind text NOT NULL,
  from_bps integer NOT NULL,
  share_bps integer NOT NULL,
  CONSTRAINT pk_ai_programme_school_override_tiers PRIMARY KEY (school_id, override_id, kind, from_bps),
  CONSTRAINT fk_ai_programme_school_override_tiers_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ai_programme_school_override_tiers_override FOREIGN KEY (override_id, school_id)
    REFERENCES app.ai_programme_school_overrides (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_ai_programme_school_override_tiers_kind CHECK (kind IN ('conversion', 'content_bonus')),
  CONSTRAINT ck_ai_programme_school_override_tiers_bps CHECK (
    from_bps BETWEEN 0 AND 10000 AND share_bps BETWEEN 0 AND 10000
  )
);

-- ---------------------------------------------------------------------------------------------------
-- 3. Versions are immutable
-- ---------------------------------------------------------------------------------------------------

CREATE FUNCTION app.ai_programme_reject_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Student AI programme versions are immutable: save a new version instead'
    USING ERRCODE = '55000';
END
$function$;

REVOKE ALL ON FUNCTION app.ai_programme_reject_change() FROM PUBLIC;

CREATE TRIGGER trg_ai_programme_versions_immutable
  BEFORE UPDATE OR DELETE ON app.ai_programme_versions
  FOR EACH ROW EXECUTE FUNCTION app.ai_programme_reject_change();
CREATE TRIGGER trg_ai_programme_version_prices_immutable
  BEFORE UPDATE OR DELETE ON app.ai_programme_version_prices
  FOR EACH ROW EXECUTE FUNCTION app.ai_programme_reject_change();
CREATE TRIGGER trg_ai_programme_version_tiers_immutable
  BEFORE UPDATE OR DELETE ON app.ai_programme_version_tiers
  FOR EACH ROW EXECUTE FUNCTION app.ai_programme_reject_change();
CREATE TRIGGER trg_ai_programme_school_overrides_immutable
  BEFORE UPDATE OR DELETE ON app.ai_programme_school_overrides
  FOR EACH ROW EXECUTE FUNCTION app.ai_programme_reject_change();
CREATE TRIGGER trg_ai_programme_school_override_tiers_immutable
  BEFORE UPDATE OR DELETE ON app.ai_programme_school_override_tiers
  FOR EACH ROW EXECUTE FUNCTION app.ai_programme_reject_change();

-- ---------------------------------------------------------------------------------------------------
-- 4. The approved defaults: version 1
-- ---------------------------------------------------------------------------------------------------

INSERT INTO app.ai_programme_versions (
  id, version_number, min_seats, max_share_bps, large_school_min_seats, large_school_share_bps,
  bonus_requires_conversion_share, measurement_offset_days, nonpayment_grace_days,
  month_to_month_share_bps, payout_mode, reason, created_by
) VALUES (
  'a1000000-0000-4000-8000-000000000001', 1, 30, 1500, 500, 800,
  true, 30, 30,
  0, 'invoice_credit', 'The approved defaults (2026-11-17).', NULL
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.ai_programme_version_prices (
  version_id, currency_id, iap_price_minor, license_price_minor, parent_price_minor
)
SELECT 'a1000000-0000-4000-8000-000000000001'::uuid, c.id, 599, 400, 400
FROM app.currencies AS c
WHERE c.code = 'USD'
ON CONFLICT (version_id, currency_id) DO NOTHING;

INSERT INTO app.ai_programme_version_tiers (version_id, kind, from_bps, share_bps)
VALUES
  ('a1000000-0000-4000-8000-000000000001', 'conversion', 0, 0),
  ('a1000000-0000-4000-8000-000000000001', 'conversion', 2500, 400),
  ('a1000000-0000-4000-8000-000000000001', 'conversion', 4000, 600),
  ('a1000000-0000-4000-8000-000000000001', 'conversion', 5500, 800),
  ('a1000000-0000-4000-8000-000000000001', 'conversion', 7000, 1000),
  ('a1000000-0000-4000-8000-000000000001', 'conversion', 8500, 1200),
  ('a1000000-0000-4000-8000-000000000001', 'content_bonus', 0, 0),
  ('a1000000-0000-4000-8000-000000000001', 'content_bonus', 6000, 150),
  ('a1000000-0000-4000-8000-000000000001', 'content_bonus', 8000, 300)
ON CONFLICT (version_id, kind, from_bps) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------
-- 5. What licences and quotes were signed with
-- ---------------------------------------------------------------------------------------------------

-- Existing licences: the defaults (version 1), attached now, with the 30 days they already had. The
-- default is a constant, so no table rewrite; it is dropped afterwards so every new licence states
-- its version.
ALTER TABLE app.school_licenses
  ADD COLUMN ai_programme_version_id uuid NOT NULL
    DEFAULT 'a1000000-0000-4000-8000-000000000001',
  ADD COLUMN ai_programme_override_id uuid,
  ADD COLUMN ai_programme_applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN nonpayment_grace_days integer NOT NULL DEFAULT 30;

ALTER TABLE app.school_licenses ALTER COLUMN ai_programme_version_id DROP DEFAULT;

ALTER TABLE app.school_licenses
  ADD CONSTRAINT fk_school_licenses_ai_programme_version FOREIGN KEY (ai_programme_version_id)
    REFERENCES app.ai_programme_versions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT fk_school_licenses_ai_programme_override
    FOREIGN KEY (ai_programme_override_id, school_id)
    REFERENCES app.ai_programme_school_overrides (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT ck_school_licenses_nonpayment_grace_days CHECK (
    nonpayment_grace_days BETWEEN 1 AND 365
  );

ALTER TABLE app.license_quotes
  ADD COLUMN ai_programme_version_id uuid,
  ADD COLUMN ai_programme_override_id uuid;

ALTER TABLE app.license_quotes
  ADD CONSTRAINT fk_license_quotes_ai_programme_version FOREIGN KEY (ai_programme_version_id)
    REFERENCES app.ai_programme_versions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT fk_license_quotes_ai_programme_override
    FOREIGN KEY (ai_programme_override_id, school_id)
    REFERENCES app.ai_programme_school_overrides (id, school_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT ck_license_quotes_ai_programme CHECK (
    ai_programme_override_id IS NULL OR ai_programme_version_id IS NOT NULL
  );

COMMENT ON COLUMN app.school_licenses.ai_programme_version_id IS
  'The global Student AI programme version this licence was signed with (000234).';
COMMENT ON COLUMN app.school_licenses.ai_programme_override_id IS
  'The school''s programme override version this licence was signed with, if the school had one (000234).';
COMMENT ON COLUMN app.school_licenses.ai_programme_applied_at IS
  'When the programme versions were attached: signed, renewed, or re-applied by the super admin (000234).';
COMMENT ON COLUMN app.school_licenses.nonpayment_grace_days IS
  'Days after an unpaid instalment''s due date that Student AI stops, from the licence''s programme values (000234).';
COMMENT ON COLUMN app.license_quotes.ai_programme_version_id IS
  'The global Student AI programme version in force when the quote was priced; NULL before 000234.';
COMMENT ON COLUMN app.license_quotes.ai_programme_override_id IS
  'The school''s programme override version in force when the quote was priced, if any (000234).';

-- ---------------------------------------------------------------------------------------------------
-- 6. Privileges and tenant isolation
-- ---------------------------------------------------------------------------------------------------

-- The console (studafy_admin) writes; the runtime role reads, to resolve a school's own values.
REVOKE ALL PRIVILEGES ON TABLE
  app.ai_programme_versions, app.ai_programme_version_prices, app.ai_programme_version_tiers,
  app.ai_programme_school_overrides, app.ai_programme_school_override_tiers
FROM PUBLIC, studafy_app;
GRANT SELECT ON TABLE
  app.ai_programme_versions, app.ai_programme_version_prices, app.ai_programme_version_tiers,
  app.ai_programme_school_overrides, app.ai_programme_school_override_tiers
TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'ai_programme_school_overrides');
SELECT app.apply_tenant_isolation('app', 'ai_programme_school_override_tiers');

COMMENT ON TABLE app.ai_programme_versions IS
  'Global Student AI programme settings, one immutable row per saved version (000234).';
COMMENT ON TABLE app.ai_programme_version_prices IS
  'A global programme version''s in-app, school licence and parent prices per currency (000234).';
COMMENT ON TABLE app.ai_programme_version_tiers IS
  'A global programme version''s conversion and content-bonus tiers (000234).';
COMMENT ON TABLE app.ai_programme_school_overrides IS
  'A school''s Student AI programme overrides, one immutable row per saved version; NULL inherits (000234).';
COMMENT ON TABLE app.ai_programme_school_override_tiers IS
  'Tier tables a school''s override version replaces (000234).';

RESET ROLE;
