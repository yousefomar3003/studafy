export default {
  // eslint is sharded per workspace package by scripts/eslint-staged.ts so that the hook lints
  // each file the way `turbo lint` does -- from inside its own package. See that script's header
  // for why a single root-level `eslint --fix` disagrees with CI (ST-290).
  "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}": ["prettier --write", "bun run scripts/eslint-staged.ts"],
  "**/*.{json,md,mdx,yml,yaml,css}": ["prettier --write"],
};
