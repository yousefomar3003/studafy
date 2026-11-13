-- Sibling discounts: a school-wide rule that discounts the fees of a family's second, third, ...
-- enrolled child automatically, instead of finance requesting a scholarship award per child.
--
--   * app.sibling_discount_settings -- one row per school: whether the rule is on, and the one fee
--                                      category it is limited to (NULL discounts every fee).
--   * app.sibling_discount_tiers    -- the percentage for a child position. A tier applies from its
--                                      position upward until a higher tier takes over, so tiers
--                                      {2: 10%, 3: 15%} mean "second child 10%, third and later 15%".
--
-- Who is a sibling is derived, never stored: enrolled students sharing a family through
-- app.parent_child_links (000072), ranked eldest first by date of birth. The eldest pays full fees.
-- The billing worker applies the rule when it generates an invoice, adding it to the student's
-- approved scholarships (000149), so ERPNext's totals stay authoritative and issued invoices are
-- never changed. Editing the rule is the school admin's sign-off (billing:approveScholarship), the
-- same approval a scholarship award needs.

SET ROLE studafy_admin;

CREATE TABLE app.sibling_discount_settings (
  school_id uuid CONSTRAINT pk_sibling_discount_settings PRIMARY KEY,
  is_enabled boolean NOT NULL DEFAULT false,
  -- NULL applies to every fee; otherwise only to invoice lines of this fee category.
  fee_category text,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sibling_discount_settings_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_sibling_discount_settings_updated_by FOREIGN KEY (updated_by, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_sibling_discount_settings_fee_category CHECK (
    fee_category IS NULL OR (fee_category = btrim(fee_category) AND fee_category <> '')
  ),
  CONSTRAINT ck_sibling_discount_settings_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.sibling_discount_tiers (
  school_id uuid NOT NULL,
  -- 2 is the second child; the first child never has a tier.
  child_position smallint NOT NULL,
  percentage numeric(5, 2) NOT NULL,
  CONSTRAINT pk_sibling_discount_tiers PRIMARY KEY (school_id, child_position),
  CONSTRAINT fk_sibling_discount_tiers_school FOREIGN KEY (school_id)
    REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_sibling_discount_tiers_settings FOREIGN KEY (school_id)
    REFERENCES app.sibling_discount_settings (school_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT ck_sibling_discount_tiers_position CHECK (child_position BETWEEN 2 AND 20),
  CONSTRAINT ck_sibling_discount_tiers_percentage CHECK (percentage > 0 AND percentage <= 100)
);

CREATE INDEX idx_sibling_discount_settings_updated_by_fk
  ON app.sibling_discount_settings (updated_by, school_id);

REVOKE ALL PRIVILEGES ON TABLE app.sibling_discount_settings, app.sibling_discount_tiers
  FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.sibling_discount_settings TO studafy_app;
GRANT SELECT, INSERT, DELETE ON TABLE app.sibling_discount_tiers TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'sibling_discount_settings');
SELECT app.apply_tenant_isolation('app', 'sibling_discount_tiers');

RESET ROLE;
