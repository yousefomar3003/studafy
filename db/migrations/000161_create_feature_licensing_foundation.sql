-- Paid features and tiers: the foundation of the feature-licensing system
-- (docs/billing/feature-licensing.md, docs/adr/0018-feature-licensing.md).
--
-- A paid feature is a key in packages/constants/src/features.ts. Who gets it is decided by grants:
-- the per-student AI add-on (app.ai_subscriptions), personal purchases (app.user_subscriptions,
-- new here) and, from session 2, school-license seats. A grant points at a tier, and a tier is an
-- app.plans row that says which features it includes and at what monthly limit. Nothing here is
-- per feature: adding a feature later is a code change only.
--
--   * app.features              -- global. One row per registered key, synced from the code list at
--                                  API boot (insert-only; never deleted). Holds what the super admin
--                                  edits: display name and status (active / paused / hidden).
--   * app.plans (+3 columns)    -- a plan with an audience is a tier: rank orders Basic < Plus < Pro
--                                  within the audience, includes_all_features makes a top tier pick
--                                  up features registered after it was defined. School plans (free)
--                                  keep audience NULL and are not tiers.
--   * app.plan_features         -- global. (tier, feature, monthly limit). NULL limit is unlimited.
--   * app.user_subscriptions    -- tenant. A personal purchase by any user (student, teacher,
--                                  parent) of one tier through one provider.
--   * app.feature_usage_meters  -- tenant. Units used per (user, feature, calendar month). The
--                                  general version of app.ai_usage_meters, which keeps recording AI
--                                  tokens unchanged.
--   * app.entitlement_subject   -- gains 'user', the version counter for a person's grants.
--
-- The existing ai_addon plan becomes the first student tier, containing ai_tutor, study_tools and
-- notebook with no unit limit, so every current AI subscriber keeps exactly today's access: the AI
-- monthly token budget (apps/api/src/modules/ai/config.ts) stays the only quota they meet.
--
-- Global tables follow app.plans (000004): no school_id, RLS-free, read-only to studafy_app, and
-- registered in db/policies/rls-coverage.ts's approved_globals. Tenant tables follow the canonical
-- shape: forced RLS through app.apply_tenant_isolation, composite (id, school_id) foreign keys,
-- school-leading indexes, no DELETE grant. No JSONB anywhere.
--
-- Status columns are text with a CHECK rather than new enum types (the 000149 precedent), except
-- user_subscriptions.status, which reuses app.subscription_status so personal subscriptions share
-- the billing state machine's vocabulary and LIVE_STATUSES.
--
-- Depends on 000004 (plans), 000007 (users), 000016 (subscription_status), 000080
-- (entitlement_subject), 000146 (the ai_addon plan).

SET ROLE studafy_admin;

-- ---------------------------------------------------------------------------------------------------
-- 1. The 'user' entitlement subject
-- ---------------------------------------------------------------------------------------------------

-- subject_id is a user id when subject_type = 'user'. Bumped whenever a person's grants change, so
-- the cached `ent:usr:{userId}` entry and the JWT staleness check see it. Not used in this
-- migration, which is what lets ADD VALUE run inside its transaction.
ALTER TYPE app.entitlement_subject ADD VALUE IF NOT EXISTS 'user';

-- ---------------------------------------------------------------------------------------------------
-- 2. app.features
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.features (
  key text CONSTRAINT pk_features PRIMARY KEY,
  display_name text NOT NULL,
  -- active: normal. paused: refused for everyone, whatever their grants (a kill switch). hidden: not
  -- offered for sale and not listed to people who do not hold it; existing grants keep working.
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Mirrors FEATURE_KEY_PATTERN in packages/constants/src/features.ts.
  CONSTRAINT ck_features_key CHECK (key ~ '^[a-z][a-z0-9_]{1,49}$'),
  CONSTRAINT ck_features_display_name CHECK (
    display_name = btrim(display_name) AND display_name <> ''
  ),
  CONSTRAINT ck_features_status CHECK (status IN ('active', 'paused', 'hidden')),
  CONSTRAINT ck_features_timestamps CHECK (updated_at >= created_at)
);

-- The launch registry, so the tier rows below can reference it. The API's boot-time sync inserts
-- any key added to the code list later with the same ON CONFLICT DO NOTHING, which also means a
-- display name or status the super admin has edited is never overwritten.
INSERT INTO app.features (key, display_name) VALUES
  ('ai_tutor', 'AI tutor'),
  ('study_tools', 'Study tools'),
  ('notebook', 'Notebook'),
  ('auto_grading', 'Auto grading'),
  ('family_plus', 'Family+')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------
-- 3. Tiers: app.plans gains audience, rank and includes_all_features
-- ---------------------------------------------------------------------------------------------------

ALTER TABLE app.plans
  ADD COLUMN audience text,
  ADD COLUMN rank smallint,
  ADD COLUMN includes_all_features boolean NOT NULL DEFAULT false;

ALTER TABLE app.plans
  ADD CONSTRAINT ck_plans_audience CHECK (
    audience IS NULL OR audience IN ('student', 'teacher', 'parent')
  ),
  -- A tier has both an audience and a rank; a school plan has neither.
  ADD CONSTRAINT ck_plans_tier CHECK ((audience IS NULL) = (rank IS NULL)),
  ADD CONSTRAINT ck_plans_rank CHECK (rank IS NULL OR rank > 0),
  ADD CONSTRAINT ck_plans_includes_all_features CHECK (
    NOT includes_all_features OR audience IS NOT NULL
  );

-- Ranks order the tiers a school or a person can currently buy, so two live tiers of one audience
-- cannot share one. A retired (inactive) tier keeps its rank without blocking its replacement.
CREATE UNIQUE INDEX uq_plans_active_audience_rank
  ON app.plans (audience, rank)
  WHERE audience IS NOT NULL AND is_active;

-- ---------------------------------------------------------------------------------------------------
-- 4. app.plan_features
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE app.plan_features (
  plan_id uuid NOT NULL,
  feature_key text NOT NULL,
  -- Units per calendar month (UTC). NULL is unlimited.
  monthly_limit integer,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_plan_features PRIMARY KEY (plan_id, feature_key),
  CONSTRAINT fk_plan_features_plan FOREIGN KEY (plan_id) REFERENCES app.plans (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_plan_features_feature FOREIGN KEY (feature_key) REFERENCES app.features (key)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_plan_features_monthly_limit CHECK (monthly_limit IS NULL OR monthly_limit > 0),
  CONSTRAINT ck_plan_features_timestamps CHECK (updated_at >= created_at)
);

-- Backs the feature foreign key's parent check and "which tiers include this feature".
CREATE INDEX idx_plan_features_feature_key ON app.plan_features (feature_key);

-- ---------------------------------------------------------------------------------------------------
-- 5. app.user_subscriptions
-- ---------------------------------------------------------------------------------------------------

-- Current state, one row per provider subscription, updated in place by the provider's webhooks --
-- the app.subscriptions shape (000016). app.billing_events keeps the event history.
CREATE TABLE app.user_subscriptions (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_user_subscriptions PRIMARY KEY,
  school_id uuid NOT NULL,
  user_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  provider text NOT NULL,
  status app.subscription_status NOT NULL,
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  -- False once renewal is turned off (by the user, or by us when a school seat covers them).
  auto_renew boolean NOT NULL DEFAULT true,
  -- The provider's own id: Apple originalTransactionId, Google purchase token, Stripe subscription
  -- id, Tap agreement id.
  provider_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_user_subscriptions_id_school UNIQUE (id, school_id),
  -- A webhook finds its row by the provider's id. School-leading, so it is also the tenant path.
  CONSTRAINT uq_user_subscriptions_school_provider_reference
    UNIQUE (school_id, provider, provider_reference),
  CONSTRAINT fk_user_subscriptions_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_user_subscriptions_user FOREIGN KEY (user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_user_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES app.plans (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_user_subscriptions_provider CHECK (
    provider IN ('app_store', 'google_play', 'tap', 'stripe')
  ),
  CONSTRAINT ck_user_subscriptions_provider_reference CHECK (
    provider_reference = btrim(provider_reference) AND provider_reference <> ''
  ),
  CONSTRAINT ck_user_subscriptions_period CHECK (current_period_end > current_period_start),
  CONSTRAINT ck_user_subscriptions_timestamps CHECK (updated_at >= created_at)
);

-- The resolver's read: one person's subscriptions. Also covers the composite user foreign key.
CREATE INDEX idx_user_subscriptions_school_user
  ON app.user_subscriptions (school_id, user_id, current_period_end DESC);
-- Which subscriptions are on a tier (repricing, retiring a tier). School-leading like every index on
-- a tenant table; the plan foreign key's parent check scans instead, which is acceptable because a
-- plan row is never deleted (RESTRICT, and tiers are retired with is_active).
CREATE INDEX idx_user_subscriptions_school_plan
  ON app.user_subscriptions (school_id, plan_id);

-- ---------------------------------------------------------------------------------------------------
-- 6. app.feature_usage_meters
-- ---------------------------------------------------------------------------------------------------

-- One row per (user, feature, calendar month), incremented atomically by requireFeature with a
-- conditional upsert so concurrent requests can never pass the limit. Monthly limits reset on the
-- 1st (UTC) whatever the grant's billing period, because a person can hold several grants with
-- different periods and a school license can run for years.
CREATE TABLE app.feature_usage_meters (
  school_id uuid NOT NULL,
  user_id uuid NOT NULL,
  feature_key text NOT NULL,
  period_start date NOT NULL,
  used bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_feature_usage_meters PRIMARY KEY (school_id, user_id, feature_key, period_start),
  CONSTRAINT fk_feature_usage_meters_school FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_feature_usage_meters_user FOREIGN KEY (user_id, school_id)
    REFERENCES app.users (id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_feature_usage_meters_feature FOREIGN KEY (feature_key)
    REFERENCES app.features (key) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_feature_usage_meters_used CHECK (used >= 0),
  CONSTRAINT ck_feature_usage_meters_period_start CHECK (extract(day FROM period_start) = 1),
  CONSTRAINT ck_feature_usage_meters_timestamps CHECK (updated_at >= created_at)
);

-- The primary key leads with school_id and covers the composite user foreign key; the feature
-- foreign key's parent is never deleted. No further index.

-- ---------------------------------------------------------------------------------------------------
-- 7. The ai_addon plan becomes the first student tier
-- ---------------------------------------------------------------------------------------------------

-- 000146 created it with ON CONFLICT DO NOTHING, so it exists on every database; re-assert it the
-- same way for a database that somehow lacks it, so the tier rows below always have a parent.
INSERT INTO app.plans (code, display_name, description, is_active)
VALUES ('ai_addon', 'Studafy AI', 'The AI study assistant, per student.', true)
ON CONFLICT (code) DO NOTHING;

UPDATE app.plans
SET audience = 'student',
    rank = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE code = 'ai_addon';

-- No unit limit: an AI subscriber today is held only by the monthly token budget, and must stay so.
INSERT INTO app.plan_features (plan_id, feature_key, monthly_limit)
SELECT p.id, f.key, NULL
FROM app.plans AS p
CROSS JOIN (VALUES ('ai_tutor'), ('study_tools'), ('notebook')) AS f (key)
WHERE p.code = 'ai_addon'
ON CONFLICT (plan_id, feature_key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------
-- 8. Student <-> user mapping for the entitlement resolver
-- ---------------------------------------------------------------------------------------------------

-- Feature resolution runs with no acting user: its result is cached per person and shared by every
-- caller, so it must not depend on who asked. app.students carries the restrictive
-- role_scope_visibility policy (000037/000133), under which a userless studafy_app transaction sees
-- no student at all. These two helpers follow 000037's pattern -- SECURITY DEFINER, owned by
-- studafy_admin, so only the permissive tenant_isolation policy applies inside -- and return nothing
-- but an id within the armed school, never a row.

-- The user behind a student record (the AI routes start from a student id).
CREATE FUNCTION app.student_user_id(target_student_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT s.user_id
  FROM app.students AS s
  WHERE s.id = target_student_id
    AND s.school_id = current_setting('app.school_id')::uuid
$function$;

-- The student record of a user, or NULL for a non-student (the AI add-on is keyed by student id).
CREATE FUNCTION app.user_student_id(target_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT s.id
  FROM app.students AS s
  WHERE s.user_id = target_user_id
    AND s.school_id = current_setting('app.school_id')::uuid
$function$;

REVOKE ALL ON FUNCTION app.student_user_id(uuid), app.user_student_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.student_user_id(uuid), app.user_student_id(uuid) TO studafy_app;

-- ---------------------------------------------------------------------------------------------------
-- 9. Privileges and tenant isolation
-- ---------------------------------------------------------------------------------------------------

-- Global, read-only at runtime (the 000004 posture). The super admin's edits and the boot-time sync
-- run through withSystemTx (studafy_admin).
REVOKE ALL PRIVILEGES ON TABLE app.features, app.plan_features FROM PUBLIC, studafy_app;
GRANT SELECT ON TABLE app.features, app.plan_features TO studafy_app;

-- No DELETE: a subscription ends by status, and a usage meter is a ledger.
REVOKE ALL PRIVILEGES ON TABLE app.user_subscriptions, app.feature_usage_meters
  FROM PUBLIC, studafy_app;
GRANT SELECT, INSERT, UPDATE ON TABLE app.user_subscriptions, app.feature_usage_meters
  TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'user_subscriptions');
SELECT app.apply_tenant_isolation('app', 'feature_usage_meters');

COMMENT ON TABLE app.features IS
  'Paid features, synced from packages/constants/src/features.ts (insert-only). Holds the super admin''s settings: display name and status.';
COMMENT ON COLUMN app.plans.audience IS
  'student | teacher | parent when the plan is a feature tier; NULL for a school plan.';
COMMENT ON COLUMN app.plans.rank IS
  'Orders the tiers of one audience (Basic < Plus < Pro). Set exactly when audience is.';
COMMENT ON COLUMN app.plans.includes_all_features IS
  'The tier includes every feature of its audience, including features registered later, at the plan_features limit or the code default.';
COMMENT ON TABLE app.plan_features IS
  'The features a tier includes and their monthly limits (NULL = unlimited).';
COMMENT ON TABLE app.user_subscriptions IS
  'Personal purchases of a tier by any user, one row per provider subscription, current state only.';
COMMENT ON TABLE app.feature_usage_meters IS
  'Units of a feature used per user per calendar month (UTC).';

RESET ROLE;
