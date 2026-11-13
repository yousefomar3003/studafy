-- Creates Studafy's first global, non-tenant application tables.
-- SAD section 10 is not present in this repository; the explicit ST-033 classification is used:
-- these six tables are global and therefore contain no school_id, tenant_id, or tenant RLS policy.

SET ROLE studafy_admin;

CREATE TYPE app.school_status AS ENUM ('pending', 'active', 'suspended', 'archived');
CREATE TYPE app.billing_interval AS ENUM ('monthly', 'yearly');
CREATE TYPE app.platform_setting_value_type AS ENUM ('boolean', 'integer', 'text');
CREATE TYPE app.platform_setting_sensitivity AS ENUM ('public', 'internal');

CREATE TABLE app.countries (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_countries PRIMARY KEY,
  alpha2_code text NOT NULL CONSTRAINT uq_countries_alpha2_code UNIQUE,
  alpha3_code text NOT NULL CONSTRAINT uq_countries_alpha3_code UNIQUE,
  numeric_code text NOT NULL CONSTRAINT uq_countries_numeric_code UNIQUE,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_countries_alpha2_code CHECK (alpha2_code ~ '^[A-Z]{2}$'),
  CONSTRAINT ck_countries_alpha3_code CHECK (alpha3_code ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_countries_numeric_code CHECK (numeric_code ~ '^[0-9]{3}$'),
  CONSTRAINT ck_countries_name CHECK (name = btrim(name) AND name <> ''),
  CONSTRAINT ck_countries_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.currencies (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_currencies PRIMARY KEY,
  code text NOT NULL CONSTRAINT uq_currencies_code UNIQUE,
  numeric_code text NOT NULL CONSTRAINT uq_currencies_numeric_code UNIQUE,
  name text NOT NULL,
  minor_unit smallint NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_currencies_code CHECK (code ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_currencies_numeric_code CHECK (numeric_code ~ '^[0-9]{3}$'),
  CONSTRAINT ck_currencies_name CHECK (name = btrim(name) AND name <> ''),
  CONSTRAINT ck_currencies_minor_unit CHECK (minor_unit BETWEEN 0 AND 4),
  CONSTRAINT ck_currencies_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.schools (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_schools PRIMARY KEY,
  slug text NOT NULL CONSTRAINT uq_schools_slug UNIQUE,
  name text NOT NULL,
  status app.school_status NOT NULL DEFAULT 'pending',
  country_id uuid NOT NULL,
  default_currency_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_schools_country
    FOREIGN KEY (country_id) REFERENCES app.countries (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_schools_default_currency
    FOREIGN KEY (default_currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_schools_slug CHECK (
    char_length(slug) BETWEEN 3 AND 63
    AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  CONSTRAINT ck_schools_name CHECK (name = btrim(name) AND name <> ''),
  CONSTRAINT ck_schools_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.plans (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_plans PRIMARY KEY,
  code text NOT NULL CONSTRAINT uq_plans_code UNIQUE,
  display_name text NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_plans_code CHECK (
    char_length(code) BETWEEN 2 AND 50
    AND code ~ '^[a-z][a-z0-9_]*$'
  ),
  CONSTRAINT ck_plans_display_name CHECK (
    display_name = btrim(display_name) AND display_name <> ''
  ),
  CONSTRAINT ck_plans_description CHECK (
    description IS NULL OR (description = btrim(description) AND description <> '')
  ),
  CONSTRAINT ck_plans_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.plan_prices (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_plan_prices PRIMARY KEY,
  plan_id uuid NOT NULL,
  currency_id uuid NOT NULL,
  billing_interval app.billing_interval NOT NULL,
  amount_minor bigint NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_plan_prices_plan
    FOREIGN KEY (plan_id) REFERENCES app.plans (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_plan_prices_currency
    FOREIGN KEY (currency_id) REFERENCES app.currencies (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT uq_plan_prices_plan_currency_interval
    UNIQUE (plan_id, currency_id, billing_interval),
  CONSTRAINT ck_plan_prices_amount_minor CHECK (amount_minor >= 0),
  CONSTRAINT ck_plan_prices_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE app.platform_settings (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_platform_settings PRIMARY KEY,
  key text NOT NULL CONSTRAINT uq_platform_settings_key UNIQUE,
  description text NOT NULL,
  value_type app.platform_setting_value_type NOT NULL,
  boolean_value boolean,
  integer_value bigint,
  text_value text,
  sensitivity app.platform_setting_sensitivity NOT NULL DEFAULT 'internal',
  is_mutable boolean NOT NULL DEFAULT false,
  requires_restart boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_platform_settings_key CHECK (
    char_length(key) BETWEEN 3 AND 100
    AND key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
  ),
  CONSTRAINT ck_platform_settings_description CHECK (
    description = btrim(description) AND description <> ''
  ),
  CONSTRAINT ck_platform_settings_typed_value CHECK (
    (value_type = 'boolean' AND boolean_value IS NOT NULL
      AND integer_value IS NULL AND text_value IS NULL)
    OR (value_type = 'integer' AND integer_value IS NOT NULL
      AND boolean_value IS NULL AND text_value IS NULL)
    OR (value_type = 'text' AND text_value IS NOT NULL
      AND boolean_value IS NULL AND integer_value IS NULL)
  ),
  CONSTRAINT ck_platform_settings_text_value CHECK (
    text_value IS NULL OR btrim(text_value) <> ''
  ),
  CONSTRAINT ck_platform_settings_timestamps CHECK (updated_at >= created_at)
);

-- Only indexes backed by a concrete join or parent-update/delete check are added. The unique
-- plan-price business key begins with plan_id, so it already indexes that foreign key.
CREATE INDEX idx_schools_country_id ON app.schools (country_id);
CREATE INDEX idx_schools_default_currency_id ON app.schools (default_currency_id);
CREATE INDEX idx_plan_prices_currency_id ON app.plan_prices (currency_id);

-- ST-031 default privileges grant CRUD to the runtime role. Global administration APIs do not yet
-- exist, so this migration narrows every global table to read-only runtime access.
REVOKE ALL PRIVILEGES ON TABLE
  app.schools,
  app.plans,
  app.plan_prices,
  app.countries,
  app.currencies,
  app.platform_settings
FROM studafy_app;

GRANT SELECT ON TABLE
  app.schools,
  app.plans,
  app.plan_prices,
  app.countries,
  app.currencies,
  app.platform_settings
TO studafy_app;

REVOKE ALL PRIVILEGES ON TABLE
  app.schools,
  app.plans,
  app.plan_prices,
  app.countries,
  app.currencies,
  app.platform_settings
FROM PUBLIC;

REVOKE ALL ON TYPE
  app.school_status,
  app.billing_interval,
  app.platform_setting_value_type,
  app.platform_setting_sensitivity
FROM PUBLIC;

GRANT USAGE ON TYPE
  app.school_status,
  app.billing_interval,
  app.platform_setting_value_type,
  app.platform_setting_sensitivity
TO studafy_app;

RESET ROLE;
