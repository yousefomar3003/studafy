import shared from "@studafy/config/eslint";

// Files still allowed to query the raw pool (studafy/no-raw-pool-query, QA-16), with how many such
// queries each holds and why. raw-pool-query-lint.test.ts fails if a file gains or loses one, so a
// new raw query cannot hide in an allowlisted file and a fixed file cannot stay listed.
//
// "Global" entries read or write tables without RLS (schools, countries, currencies, plans,
// plan_prices): no tenant leak, but they still run as the database login. "Tenant" entries touch
// RLS tables with no role or school set, the S-01 risk; each is tracked in F-17 (QA-29).
export const RAW_POOL_QUERY_ALLOWLIST_COUNTS = {
  // Global: lists the schools to reconcile, then one tenant transaction per school.
  "apps/api/src/modules/finance/jobs/reconciliation.job.ts": 1,
  // Global: country/currency reference data for the application form.
  "apps/api/src/modules/school-applications/service.ts": 1,
  // Global: plan and price catalog writes during the Stripe sync.
  "apps/api/src/modules/subscriptions/services/price-sync-service.ts": 4,
  // Global: active plans and prices.
  "apps/api/src/modules/subscriptions/services/subscription-service.ts": 2,
  // Global: country/currency lookups.
  "apps/api/src/modules/tenancy/lookups/service.ts": 2,
  // Global: the school's provisioning status.
  "apps/api/src/modules/tenancy/provisioning/route.ts": 1,
  // Tenant (F-17): app.subscriptions and app.erpnext_site_configs read and written unscoped.
  "apps/api/src/modules/tenancy/provisioning/service.ts": 5,
  // Global: slug/email uniqueness pre-check.
  "apps/api/src/modules/tenancy/registration/service.ts": 1,
  // Tenant (F-17): the school's first admin read from app.users unscoped; the rest is app.schools.
  "apps/api/src/modules/tenancy/verification/service.ts": 4,
};

export const RAW_POOL_QUERY_ALLOWLIST = Object.keys(RAW_POOL_QUERY_ALLOWLIST_COUNTS);

// k6 scripts (infra/load-tests) run inside k6's own goja runtime, not Node: `__ENV`/`__VU`/
// `__ITER`/`open` are k6-injected globals with no `@types` package, and `k6`/`k6/*` are virtual
// modules the k6 binary resolves internally — neither exists as a real npm package for
// import-x's resolver to find. This override is scoped to exactly those files rather than
// touching the shared config in packages/config, which every other workspace also consumes.
export default [
  ...shared,
  {
    files: ["infra/load-tests/{config,lib,scenarios}/**/*.js"],
    languageOptions: {
      globals: {
        __ENV: "readonly",
        __VU: "readonly",
        __ITER: "readonly",
        open: "readonly",
      },
    },
    rules: {
      "import-x/no-unresolved": ["error", { ignore: ["^k6($|/)"] }],
    },
  },
  // ST-297: every SQL string apps/api sends must be static; runtime values travel as bound
  // parameters. Scoped to the API's shipped source (request-reachable code), not its tests: test
  // suites build DDL and DO-block fixtures (CREATE DATABASE "<name>", per-table RLS probes) from
  // test-owned identifiers and statements, which Postgres cannot bind as parameters anyway.
  // See CONTRIBUTING.md › SQL safety.
  {
    files: ["apps/api/src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/__tests__/**"],
    rules: {
      "studafy/no-interpolated-sql": "error",
    },
  },
  // QA-16 (S-01): module code queries the database only inside a transaction that set the role and
  // tenant (withTenantTx/withSystemTx). A query on the raw pool runs as the PgBouncer login with
  // neither, so RLS either does not apply or matches nothing. See CONTRIBUTING.md › SQL safety.
  {
    files: ["apps/api/src/modules/**/*.ts"],
    ignores: ["**/*.test.ts", "**/__tests__/**"],
    rules: {
      "studafy/no-raw-pool-query": "error",
    },
  },
  {
    files: RAW_POOL_QUERY_ALLOWLIST,
    rules: {
      "studafy/no-raw-pool-query": "off",
    },
  },
];
