import shared from "@studafy/config/eslint";

// Files still allowed to query the raw pool (studafy/no-raw-pool-query, QA-16), with how many such
// queries each holds and why. raw-pool-query-lint.test.ts fails if a file gains or loses one, so a
// new raw query cannot hide in an allowlisted file and a fixed file cannot stay listed.
//
// "Global" entries read or write tables without RLS (schools, countries, currencies, plans,
// plan_prices): no tenant leak, but they still run as the database login. "Tenant" entries touch
// RLS tables with no role or school set, the S-01 risk; each is tracked in F-17 (QA-29).
export const RAW_POOL_QUERY_ALLOWLIST_COUNTS = {
  // Since QA-014 every query that reads or writes a table runs inside withTenantTx / withSystemTx /
  // withAppTx, so none depends on the database login's own privileges. Add an entry only with a
  // reason a least-privilege login can still serve.
  // Readiness probe: `select 1` touches no table, so it works for any login.
  "apps/api/src/db/client.ts": 1,
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
  // Widened from apps/api/src/modules/** by QA-014: the webhooks in apps/api/src/email and
  // apps/api/src/erpnext and the workers fell outside it, and two of them depended on RLS bypass.
  {
    files: ["apps/api/src/**/*.ts", "apps/workers/src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/__tests__/**"],
    rules: {
      "studafy/no-raw-pool-query": "error",
    },
  },
  // ESLint rejects an empty `files`, so the override exists only while the allowlist has entries.
  ...(RAW_POOL_QUERY_ALLOWLIST.length > 0
    ? [
        {
          files: RAW_POOL_QUERY_ALLOWLIST,
          rules: {
            "studafy/no-raw-pool-query": "off",
          },
        },
      ]
    : []),
];
