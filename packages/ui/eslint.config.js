import baseConfig from "@studafy/config/eslint";
import { defineConfig } from "eslint/config";
import globals from "globals";

/**
 * The shared config targets Node, so `document`, `window`, `KeyboardEvent` and friends would all
 * trip `no-undef` here. This package renders in the browser — nothing else about the base config
 * changes.
 */
export default defineConfig([
  ...baseConfig,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
]);
