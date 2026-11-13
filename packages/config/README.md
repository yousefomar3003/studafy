# @studafy/config

Shared ESLint and Prettier configuration for the studafy monorepo. Every workspace inherits
these through the two root files (`eslint.config.js`, `prettier.config.js`) instead of
maintaining local rule forks.

## How it's wired up

- `eslint.config.js` / `prettier.config.js` at the **repo root** each re-export this package's
  preset (`@studafy/config/eslint`, `@studafy/config/prettier`).
- ESLint's flat config and Prettier's config loader both search upward from the file being
  linted/formatted through ancestor directories until they find a config file. Because no
  workspace (`apps/*`, `packages/*`) defines its own `eslint.config.js` or `prettier.config.js`,
  every workspace resolves to the root files — and therefore to this package — automatically.
- Each workspace's `package.json` only needs a `lint` script (`eslint .`) and a `workspace:*`
  devDependency on `@studafy/config` (for Turbo's cache graph). No rule configuration lives in
  the workspace itself.

## Overriding for a specific package (documented exception)

If a future package genuinely needs different rules (e.g. a React app needs JSX a11y rules),
add a local `eslint.config.js` in that package's root that imports and extends the shared
preset, and record _why_ in that package's own README or an ADR:

```js
import baseConfig from "@studafy/config/eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([...baseConfig, { files: ["**/*.tsx"], rules: {/* ... */} }]);
```

A local file "wins" over the root one for files under that package, because ESLint stops its
upward search at the first config file it finds. Do this only when the exception is documented
— per ST-003's acceptance criteria, undocumented local rule forks are not allowed.

## Rule catalog

### ESLint

| Category               | Source                                                                                                                                                                                         | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Exceptions                                                                                                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core JS correctness    | `@eslint/js` `recommended`                                                                                                                                                                     | Baseline error-prevention rules (no unreachable code, no dupe keys, etc.) that apply to any JS/TS file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Essentially never — these catch real bugs.                                                                                                                                                                                                                                     |
| TypeScript correctness | `typescript-eslint` `recommended` (non type-checked)                                                                                                                                           | Catches TS-specific footguns (misused `any`, unnecessary type assertions, etc.) without requiring every consumer to wire up `parserOptions.projectService` against a specific `tsconfig.json`. Type-aware (`recommendedTypeChecked`) linting was deliberately not chosen at this skeleton stage — it adds real setup cost (each workspace must expose a resolvable tsconfig to the linter) for marginal extra bug-catching over `tsc --noEmit`, which the `check-types` task already runs. Revisit if the repo grows API surface where type-aware lint rules (e.g. floating promises) earn their cost. | A workspace with a stable, single-project tsconfig may opt into `recommendedTypeChecked` locally if it has a concrete need (e.g. `no-floating-promises` in an async-heavy service).                                                                                            |
| TypeScript stylistic   | `typescript-eslint` `stylistic`                                                                                                                                                                | Consistent TS idioms (`interface` vs `type` preferences, array type syntax) — these are logical/syntax preferences, not whitespace, so they don't conflict with Prettier.                                                                                                                                                                                                                                                                                                                                                                                                                              | None expected.                                                                                                                                                                                                                                                                 |
| Import ordering        | `eslint-plugin-import-x` `flatConfigs.recommended` + `flatConfigs.typescript` + custom `import-x/order`                                                                                        | Deterministic, alphabetized import groups (builtin → external → internal → parent → sibling → index → type) with the TypeScript resolver so path aliases (`@/*`) and workspace packages (`@studafy/*`) are understood. Prevents merge-conflict-prone import reordering and makes module boundaries visually obvious. `import-x` (not the original `eslint-plugin-import`) was chosen because it's flat-config-native and meaningfully faster.                                                                                                                                                          | `import-x/no-unresolved` is deliberately **not** enabled — `tsc --noEmit` (the `check-types` task) already catches unresolved imports with full type information; duplicating that check in ESLint only risks false positives without a fully-tuned resolver.                  |
| Security               | `eslint-plugin-security` `recommended`                                                                                                                                                         | Flags common Node/JS injection and unsafe-API patterns (unsafe regex, non-literal `require`/`fs` paths, `eval`, timing-unsafe comparisons, etc.) at author-time rather than in a separate security review pass.                                                                                                                                                                                                                                                                                                                                                                                        | The plugin's own docs note real false-positive risk, particularly `detect-object-injection` on plain bracket property access. If a rule fires on a genuinely safe pattern, disable it **inline** for that line with a comment explaining why, rather than disabling repo-wide. |
| Best-practice defaults | Hand-picked: `eqeqeq` (smart), `no-var`, `prefer-const`, `no-implicit-coercion`, `curly` (all), `object-shorthand`, `@typescript-eslint/no-unused-vars` (warn, `_`-prefixed args/vars ignored) | Small, uncontroversial set of rules with essentially zero false-positive rate. Kept deliberately short — broad "best practice" plugins (e.g. `eslint-plugin-unicorn`) were not pulled in to avoid an opinionated, hard-to-review rule surface at skeleton stage.                                                                                                                                                                                                                                                                                                                                       | None expected; extend this list with justification rather than adding a whole new plugin for one rule.                                                                                                                                                                         |
| Prettier interop       | `eslint-config-prettier/flat` (last in the config array)                                                                                                                                       | Turns off any ESLint rule that would fight with Prettier's formatting output. Deliberately **not** using `eslint-plugin-prettier` (running Prettier as an ESLint rule) — it's slower and reports the same issue through two different tools; formatting is Prettier's job exclusively.                                                                                                                                                                                                                                                                                                                 | None.                                                                                                                                                                                                                                                                          |

### Prettier

| Option          | Value      | Why                                                                                                                                     |
| --------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `semi`          | `true`     | Explicit statement termination; avoids ASI edge cases.                                                                                  |
| `singleQuote`   | `false`    | Matches the double-quote style already used in this repo's JSON/config files.                                                           |
| `trailingComma` | `"all"`    | Minimizes diff noise when adding a new last element/argument.                                                                           |
| `printWidth`    | `100`      | Wider than Prettier's 80 default to reduce wraps in TypeScript's often-long type signatures, without going so wide readability suffers. |
| `tabWidth`      | `2`        | Matches existing repo JSON formatting (`package.json`, `tsconfig.json`).                                                                |
| `arrowParens`   | `"always"` | Consistent regardless of arg count; avoids reformatting when a single-arg arrow gains a second parameter.                               |
| `endOfLine`     | `"lf"`     | Deterministic across Windows/macOS/Linux contributors and CI.                                                                           |

## Consuming this package

1. Add it as a devDependency of your workspace:

   ```json
   { "devDependencies": { "@studafy/config": "workspace:*" } }
   ```

2. Add a `lint` script:

   ```json
   { "scripts": { "lint": "eslint ." } }
   ```

3. That's it — no local `eslint.config.js` or `prettier.config.js` needed. The root config
   files apply automatically.
