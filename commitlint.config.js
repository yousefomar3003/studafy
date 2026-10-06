export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Body/footer wrapping is cosmetic; long bullet lines (often from generated messages)
    // shouldn't block a commit. The header length limit still applies.
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
