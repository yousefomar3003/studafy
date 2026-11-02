import shared from "@studafy/config/eslint";

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
];
