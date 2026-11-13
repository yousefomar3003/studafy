# ADR-010: Runtime — Bun for everything, or nothing

## Status

Accepted

## Context

The repository is entirely TypeScript: HTTP API (`apps/api`), background workers (`apps/workers`),
shared packages, and codegen tooling. Every artifact needs a runtime, an installer, a test runner,
and a way to bundle and deploy. Before this decision the repo had not committed to a runtime — the
first monorepo ADR (ADR-0000) picked Bun Workspaces + Turborepo for dependency management and task
orchestration but explicitly deferred the runtime question. This ADR records the runtime choice and
its consequences for how a worker is packaged.

## Decision

- **Bun is the runtime.** All packages declare `bun` in their scripts and run under it: `bun test`
  for the test suites, `bun run <script>` for every task, `bun --filter` for per-workspace
  execution. `package.json` pins `"packageManager": "bun@1.3.14"` so there is exactly one supported
  version, and `bun.lock` + `bunfig.toml` (telemetry off, exact install) are committed.
- **Bun is used even where Node would "do fine".** The API server, the workers, the codegen scripts,
  and the tooling all run on the same runtime. There is deliberately no hybrid where "the serious
  service runs on Node" and Bun is only for dev tooling — that would mean operating two runtimes for
  one language and two sets of native dependencies.
- **Bundling is part of the contract.** `bun build --target bun` produces the single-file bundles
  the production worker image ships — e.g. the OCR path in ADR-0007 (`bun run build:ocr` bundles the
  tesseract worker script and copies its WASM cores), and the production image runs only
  `apps/workers/dist` with no `node_modules`. A "bundle only, no node_modules" image is only
  practical because Bun produces self-contained bundles from the same build authoring we already use.
- **Runtime and package manager are the same tool.** This is what makes install fast and
  workspaces work (ADR-0000); there is no npm/yarn/pnpm path in the repo.

## Alternatives considered

- **Node 22 as the runtime with npm/pnpm only for install** — the conventional, well-trodden
  choice. Rejected: installing and testing are measurably slower, watch-mode and in-repo package
  linking are second-class, and we would still have to maintain a separate bundler story for the
  no-`node_modules` worker image. Nothing in the codebase required a Node-only API that Bun could not
  serve.
- **Deno** — good runtime, tighter sandbox, but a weaker npm ecosystem story for a repo that
  depends on npm packages as its default, and it would be the odd one out in the "workspace of npm
  packages" shape ADR-0000 commits to.
- **Node for API, Bun for workers (or vice-versa)** — rejected as the two-runtime tax: two base
  images, two dependency sets, and every package must rot spec-compatibly in both.

## Consequences

- A new contributor must install Bun 1.3.14; there is no fallback path (enforced via
  `packageManager`). Docker images and CI use Bun, not Node.
- Native dependencies must be Bun-compatible; any dependency that requires a Node-specific native
  binary is a porting cost in review, not a surprise.
- Test infrastructure (`bun test`, refactor/watch UX, benchmark gating like
  `REFRESH_ROTATION_BENCHMARK=1` in SAD_13) is owned once and behaves the same in CI and locally.
- Worker packaging has a fixed shape: `bun build --target bun` → `dist/` → image. A deployable that
  needs `node_modules` at runtime signals a bundling problem, not a new rule.

## Review

Reviewed by `baderalhindi` on 2026-09-11.
