-- Per-tenant feature-flag overrides (ST-277 feature-flag service).
--
-- One row per (school, flag) that deviates from the platform default. The defaults themselves are
-- the `defaultValue`s in @studafy/constants' FEATURE_FLAGS registry, overridable per deployment by
-- environment variables (e.g. `AI_LLM_ENABLED`); this table is the top layer of that precedence:
-- a row here wins for its school, either direction, for as long as it exists.
--
-- ## Why per-tenant, and why RLS
--
-- Flags evaluate per authenticated request, and this table's only consumer guards a tenant's own
-- AI surface, so it is an ordinary tenant table (`apply_tenant_isolation`, SELECT-only for
-- studafy_app under the `app.school_id` GUC) rather than a global one. It cannot accidentally leak
-- another school's override to an RLS-scoped query.
--
-- ## Why studafy_app gets SELECT only
--
-- An override is *platform-administered* operational state, not a tenant's own preference: writing
-- it grants the school the ability to flip its own AI kill switches. Writes therefore run as
-- `studafy_admin` through controlled maintenance SQL, exactly the posture
-- docs/database/global-tables.md documents for `app.platform_settings`. The <30s no-deploy flip
-- workflow is spelled out in docs/database/feature-flags-data-model.md.
--
-- `flag_name` deliberately carries no CHECK against the TypeScript registry: the registry moves in
-- code, and hardcoding its atoms here would let the two diverge. The CHECK instead constrains the
-- *shape* (dotted lowercase, bounded length), so a typo'd flag name is caught by the app's typed
-- lookups (`FlagName`) rather than silently matching nothing.
--
-- Only the rows below stay warm in Redis (one key per (school, flag), TTL-bounded). An override
-- row an operator inserts for a flag no consumer evaluates costs nothing: it is a dead row, not a
-- broadcast.
--
-- Depends on 000004 (app.schools), 000006/000025 (app.apply_tenant_isolation).

SET ROLE studafy_admin;

CREATE TABLE app.feature_flags (
  school_id uuid NOT NULL,
  flag_name text NOT NULL,
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_feature_flags PRIMARY KEY (school_id, flag_name),
  CONSTRAINT fk_feature_flags_school
    FOREIGN KEY (school_id) REFERENCES app.schools (id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  -- Dotted-lowercase name shape, matching the platform_settings key convention (000004). The
  -- registry at @studafy/constants FEATURE_FLAGS defines the closed set of real names.
  CONSTRAINT ck_feature_flags_name CHECK (
    flag_name ~ '^[a-z][a-z0-9]*(\.[a-z0-9]+)+$'
    AND char_length(flag_name) <= 100
  )
);

REVOKE ALL PRIVILEGES ON TABLE app.feature_flags FROM PUBLIC;
-- Mandatory, not decoration: 000002's ALTER DEFAULT PRIVILEGES has already granted studafy_app
-- SELECT/INSERT/UPDATE/DELETE by the time this line runs, so a bare GRANT below would leave the
-- write privileges (and DELETE) in place. The read path is the only one the API surface exercises;
-- flipping a flag is an operator's studafy_admin write, documented in feature-flags-data-model.md.
REVOKE ALL PRIVILEGES ON TABLE app.feature_flags FROM studafy_app;
GRANT SELECT ON TABLE app.feature_flags TO studafy_app;

SELECT app.apply_tenant_isolation('app', 'feature_flags');

COMMENT ON TABLE app.feature_flags IS
  'Per-tenant feature-flag overrides, the top layer of the flag precedence (registry default -> env default -> this table). Platform-administered; studafy_app reads only.';
COMMENT ON COLUMN app.feature_flags.enabled IS
  'The overridden value for this school. Absent rows resolve to the deployment default for the flag.';

RESET ROLE;