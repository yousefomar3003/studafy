export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Line length is cosmetic; long headers or bullet lines (often from generated messages)
    // shouldn't block a commit. Type and format rules still apply. Aim for headers under ~72
    // characters anyway -- GitHub truncates longer ones in commit lists.
    "header-max-length": [0],
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "style",
        "refactor",
        "perf",
        "test",
        "build",
        "ci",
        "chore",
        "revert",
        "infra",
      ],
    ],
  },
};
