# ADR-000: Monorepo tooling — Bun workspaces + Turborepo

## Status

Accepted

## Context

Studafy will contain multiple apps and shared packages (web app, API, shared
UI/config libraries). We need a single-repo setup that:

- installs dependencies once and hoists/links shared packages without
  publishing them to a registry
- runs tasks (build, lint, test) across many packages without re-running work
  that hasn't changed
- stays fast on a single dev machine and in CI

## Decision

Use **Bun workspaces** for dependency management and package linking, and
**Turborepo** for task orchestration and caching.

- `package.json#workspaces` = `["apps/*", "packages/*"]` — flat, conventional
  globs, no nested workspace groups.
- `turbo.json` defines the task pipeline (currently just `build`, with
  `dependsOn: ["^build"]` so a package builds after its workspace
  dependencies, and `outputs: ["dist/**"]` so Turbo can cache and skip
  unchanged work).

## Alternatives considered

- **npm/pnpm/yarn workspaces + Turborepo** — pnpm is the more common pairing
  with Turborepo and has stricter node_modules isolation. Rejected for now:
  Bun's installer is significantly faster, and this repo doesn't yet have a
  reason to need pnpm's stricter hoisting guarantees. Can revisit if phantom
  dependency issues show up as the repo grows.
- **Nx** — more built-in generators and a plugin ecosystem, but heavier
  configuration surface than this repo needs at zero-apps stage.
- **No task runner (raw `bun --filter` scripts)** — works for install/run but
  has no caching, so CI would rebuild everything on every change.

## Consequences

- Every workspace package's `build` script must be a real, cacheable command
  (produce output under `dist/`, matching `turbo.json`'s `outputs`) —
  no-op/echo scripts defeat the point of caching and hide broken builds.
- Contributors need Bun installed locally; there is no npm/yarn/pnpm
  fallback path (enforced loosely via `packageManager` in `package.json`).
- Adding a task (lint, test, typecheck) means adding it to `turbo.json` and to
  the workspaces that need it — not before those tasks actually exist.
