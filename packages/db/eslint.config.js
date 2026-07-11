import baseConfig from "@studafy/config/eslint";

export default [
  ...baseConfig,
  {
    files: ["tests/**/*.ts"],
    rules: {
      // bun:test is a Bun runtime module, not a package the Node resolver can locate on disk.
      "import-x/no-unresolved": ["error", { ignore: ["^bun:test$"] }],
    },
  },
];
