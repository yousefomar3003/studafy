# Feature flags data model

Runtime feature toggles for the API surface, backed by a small per-tenant table in Postgres and a
10-second Redis cache in the API. The two AI kill switches (`ai.llm`, `ai.rerank`) are the first
consumers; the model is generic.

## Source of truth: the registry

`@studafy/constants` owns `FEATURE_FLAGS` (`packages/constants/src/feature-flags.ts`) — a
compile-time registry that maps each flag name to its production default. `FlagName` is the
exhaustive union of its keys, so:

- an unknown flag name fails `check-types` everywhere (the `defaults` map in the API is typed
  `Partial<Record<FlagName, boolean>>`, so a typo is a build error, not a runtime surprise), and
- adding a flag means touching the registry first.

| Flag        | Registry default | API deployment default                | Consumers                                                                                                                                 |
| ----------- | ---------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.llm`    | `false`          | `AI_LLM_ENABLED` (default `false`)    | LLM gateway + the 7 generate routes (`/ai/gateway`, ask, summary, concepts, explain, quiz, flashcard) — off answers `503 AI_LLM_DISABLED` |
| `ai.rerank` | `false`          | `AI_RERANK_ENABLED` (default `false`) | Hybrid-retrieval cross-encoder stage (evaluated per request)                                                                              |

Quiz grading and flashcard review never call the provider, so they are intentionally **not** gated
by `ai.llm` — the flag kills generation, not evaluation.

## Precedence

A flag's effective value for a request with a school context is:

```
registry default (false)  <-env default overrides->  per-tenant app.feature_flags row (wins)
```

Three layers, later wins:

1. **Registry default** — the constant in `feature-flags.ts`. The floor when nothing else is set.
2. **Deployment default** — the API environment variable read at bootstrap
   (`AI_LLM_ENABLED`/`AI_RERANK_ENABLED` in `apps/api/src/index.ts`). Changes with a deploy.
3. **Per-tenant override** — a row in `app.feature_flags`. Wins in **either direction**:
   `enabled = true` overrides the env default `false`, and `enabled = false` overrides an env
   default of `true`. This is deliberate (decision recorded against ST-277): the operator's data
   model can express "on by default, off for this one school" and "off by default, on for these
   pilot schools" with the same rows.

A flag evaluated **without** a school context (no `schoolId`) degenerates to layer 1/2 — registry
default, env default if provided. Requests always carry a school, so this is only the fallback.

## Read path (the API)

`createFlagsService` (`apps/api/src/modules/flags/service.ts`) is the only reader. Per request:

```
flags.get(name, { schoolId })
  ├─ no ctx or no DB consulted  → defaults[name] ?? flagDefault(name)
  ├─ cacheKey(schoolId, "flags", name) → singleFlight → withTenantTx (studafy_app)
  └─ resolveFlagOverride(tx, name) → override ?? defaultFor → setCache(…, TTL=10s)
```

- **Redis is fail-open, not fail-closed**: a read that errors is logged and skipped — the DB is
  the source of truth and the cache is only a hot path. A Redis outage must not block traffic.
- The cache TTL (10s, `FLAGS_CACHE_TTL_SECONDS`) is the propagation bound for a flip: a change
  lands within a configurable bound strictly under the 30s "propagates without a deploy" bar.
- Each cache entry is per-school (`sch:{schoolId}:flags:{flagName}` via the branded `cacheKey`),
  keyspace row documented in `docs/runbooks/redis-conventions.md`.
- Reads go through a tenant-isolated transaction: `apply_tenant_isolation` builds RLS so a request
  can only ever see the school in its token.

## Write path (operators)

There is deliberately **no admin API** — flipping a flag is a `studafy_admin` SQL write, matching
the `app.platform_settings` posture. `studafy_app` holds **SELECT only** (000109 explicitly revokes
the write grants 000002's default privileges would otherwise have created).

Upsert (idempotent, preserves `updated_at`):

```sql
-- As studafy_admin against the API database.
INSERT INTO app.feature_flags (school_id, flag_name, enabled)
VALUES ('<school_id>'::uuid, 'ai.llm', true)
ON CONFLICT (school_id, flag_name)
DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = CURRENT_TIMESTAMP;
```

Look up a school by slug first if you don't have its id:

```sql
SELECT id FROM app.schools WHERE slug = '<school-slug>';
```

Clear a row (back to the deployment default):

```sql
DELETE FROM app.feature_flags WHERE flag_name = 'ai.llm';
```

If the deployment default's Redis cache holds a stale verdict, the 10s TTL bounds the wait — or,
for an emergency flip you want immediate, `DEL` the specific key
(`sch:<school_id>:flags:ai.llm`) as `studafy_admin`'s Redis user.

## Outage interplay

The env kill switches stop being a total kill the moment an override row exists: a school with
`ai.llm = true` (or `ai.rerank = true`) stays on when `AI_LLM_ENABLED=false` is deployed. The
outage runbook (`docs/runbooks/ai-provider-outage.md`) therefore includes listing and clearing
override rows as part of stop-the-load.

## Table DDL (migration 000109)

```sql
-- app.feature_flags: school_id + flag_name PK, FK -> app.schools (CASCADE),
-- ck_feature_flags_name enforces dotted-lowercase <= 100, updated_at auto-refreshed.
CREATE TABLE app.feature_flags (
  school_id  uuid      NOT NULL REFERENCES app.schools (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  flag_name  text      NOT NULL CHECK (flag_name ~ '^[a-z0-9]+(\.[a-z0-9]+){1,}$' AND char_length(flag_name) <= 100),
  enabled    boolean   NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_feature_flags PRIMARY KEY (school_id, flag_name),
  CONSTRAINT ck_feature_flags_name CHECK (...)
);
```

Ownership, grants, and tenant isolation are applied by the migration (`studafy_admin` owner,
`REVOKE` from `PUBLIC` and from `studafy_app` write privileges, `GRANT SELECT` to `studafy_app`,
`SELECT app.apply_tenant_isolation('app', 'feature_flags')`). A delete atomically makes the school
fall back to the deployment default within the cache TTL.
