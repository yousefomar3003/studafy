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
];
