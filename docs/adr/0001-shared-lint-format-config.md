# ADR-001: Shared lint/format config as a root-inherited package

## Status

Accepted

## Context

The repo had no linting or formatting tooling (ADR-000 explicitly deferred this: "adding a
task ... means adding it to `turbo.json` and to the workspaces that need it — not before those
tasks actually exist"). As `apps/*` and `packages/*` grow, we need one deterministic rule set
that every workspace shares, rather than each workspace hand-rolling its own ESLint/Prettier
config, so review comments about style/rule drift stop being a per-package negotiation.

`packages/tsconfig` already established the "shared config package, consumed via `workspace:*`
devDependency" pattern for TypeScript compiler options. Lint/format config should follow the
same shape rather than inventing a second convention.

## Decision

- New workspace `packages/config` (`@studafy/config`) owns the actual ESLint flat config and
  Prettier config as real dependencies (`typescript-eslint`, `eslint-plugin-import-x`,
  `eslint-plugin-security`, `eslint-config-prettier`, etc.), exposed via package `exports`:
  `@studafy/config/eslint` and `@studafy/config/prettier`.
- A single root-level `eslint.config.js` and `prettier.config.js` each re-export this package's
  preset. No workspace defines its own config file. This relies on ESLint's flat config and
  Prettier's config loader both searching upward through ancestor directories from the file
  being processed — a workspace with no local config file automatically inherits the root one.
- `eslint`, `prettier`, and `typescript` are `peerDependencies` of `@studafy/config` (the repo
  root controls the actual installed version, matching how `@studafy/tsconfig` treats
  `typescript`); the rule/plugin packages themselves are regular `dependencies` so consumers
  never install them directly.
- `turbo.json` gets a `lint` task (`dependsOn: ["^lint"]`, no cacheable `outputs`, matching the
  shape of the existing `check-types` task). Each workspace gets a `"lint": "eslint ."` script.
  Prettier runs as plain root-level scripts (`format`, `format:check`) over the whole repo
  rather than a per-workspace Turbo task — formatting isn't meaningfully parallelizable or
  worth caching at this repo size.

## Alternatives considered

- **Per-workspace `eslint.config.js` files that each import and re-export the shared preset** —
  works, but is pure duplication (every new workspace needs the same three-line file) with zero
  behavioral benefit over relying on upward config search. Rejected for redundancy.
- **`eslint-plugin-prettier` (running Prettier as an ESLint rule)** — keeps everything under one
  `eslint` invocation, but is slower (Prettier's formatter runs per-rule inside ESLint's lint
  pass) and reports the same issue through two overlapping tools. Rejected; Prettier runs
  standalone and `eslint-config-prettier` just disables the ESLint rules that would conflict.
- **`typescript-eslint`'s `recommendedTypeChecked` (type-aware linting)** — catches more bugs
  (e.g. floating promises) but requires every consumer to wire `parserOptions.projectService`
  against a resolvable `tsconfig.json`, and duplicates checks `tsc --noEmit` (`check-types`)
  already performs. Rejected for now as unnecessary setup cost at skeleton stage; documented in
  `packages/config/README.md` as an opt-in per-workspace override if a concrete need arises.

## Consequences

- Adding a new `apps/*` or `packages/*` workspace that wants lint gets it by adding
  `@studafy/config` as a `workspace:*` devDependency and a `"lint": "eslint ."` script — no
  rule authoring required.
- A workspace that needs different rules must add its own local `eslint.config.js` that
  extends the shared preset, and document why (see `packages/config/README.md`) — an
  undocumented local rule fork is a review finding, not a silent allowance.
- `bun run format` / `bun run format:check` operate on the whole repo in one pass; they are not
  part of Turbo's cached task graph.
