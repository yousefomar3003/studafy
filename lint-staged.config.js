export default {
  "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}": ["prettier --write", "eslint --fix"],
  "**/*.{json,md,mdx,yml,yaml,css}": ["prettier --write"],
};
