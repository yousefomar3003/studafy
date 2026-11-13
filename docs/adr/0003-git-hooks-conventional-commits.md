# ADR-003: Git hooks via Lefthook + commitlint for Conventional Commits

## Status

Accepted

## Context

The repo had no Git hook tooling: no formatting/lint/typecheck gate ran before a commit, and
commit messages had no enforced structure (though history already followed Conventional Commits
informally, e.g. `feat(shared-schemas): ...`). As the number of contributors and workspaces
grows, we want fast, local feedback on staged changes and a consistent commit history, without
duplicating the linting/formatting decisions already made in ADR-001.

## Decision

- **Lefthook** manages Git hooks (`lefthook.yml`), installed via a root `prepare` script
  (`lefthook install`) so `bun install` sets hooks up for every contributor automatically.
  Hook commands invoke `node_modules/.bin/<tool>` directly (not `bunx`/`npx`), which avoids
  wrapper-resolution overhead and works regardless of shell `PATH` configuration.
- **`pre-commit`** runs two jobs in parallel:
  - `lint-staged` (`lint-staged.config.js`) runs Prettier and `eslint --fix` against staged
    files only, re-staging the result. It reuses the existing `@studafy/config`-derived
    `eslint.config.js`/`prettier.config.js` from ADR-001 — no new rules are defined here.
  - `turbo run check-types --filter="[HEAD]"` (gated by a `glob` so it only runs when staged
    files include TypeScript), reusing the existing `check-types` Turbo task from ADR-001.
    `--filter="[HEAD]"` scopes Turbo to only the packages changed relative to `HEAD`, so a
    typical single-package change type-checks one package instead of the whole graph.
- **`commit-msg`** runs `commitlint --edit {1}` against `commitlint.config.js`, which extends
  `@commitlint/config-conventional` and adds a custom `infra` commit type (not part of the
  standard config) since this repo's infra/tooling work uses that type.

## Alternatives considered

- **Husky** — the more common Node hook tool, but requires a separate shell script per hook and
  has no native parallel command execution or staged-file globbing; Lefthook's single YAML file
  covers both with less boilerplate. Rejected since the repo has no prior Husky investment to
  preserve.
- **Running `turbo run check-types` unscoped on every commit** — simplest to configure, but
  defeats the "under 10 seconds" goal as the workspace count grows. Rejected in favor of Turbo's
  built-in `--filter="[HEAD]"` changed-package selector.
- **Embedding `lint-staged` config inline in `package.json`** — works, but breaks the
  established pattern of standalone `<tool>.config.js` files (`eslint.config.js`,
  `prettier.config.js`) this repo already uses. Rejected for naming consistency.

## Consequences

- New contributors get hooks automatically on `bun install` — no manual `lefthook install` step
  documented as required, though it's noted in `CONTRIBUTING.md` as a troubleshooting fallback.
- Invalid commit messages (including a wrong `type` or missing `scope:` separator) are rejected
  locally before they enter history.
- `git commit --no-verify` remains available as an emergency bypass (documented in
  `CONTRIBUTING.md`); it does not change what's required before merge.
- If a future workspace needs a different `check-types` invocation, the Turbo task in
  `turbo.json` — not `lefthook.yml` — is the place to change it, keeping the same separation of
  concerns as ADR-001.
