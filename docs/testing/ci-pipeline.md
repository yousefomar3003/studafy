# CI pipeline (`.github/workflows/ci.yml`)

Reference for what runs on every pull request and every push to `dev`, why it's split the way it
is, and the honest limits of the caching/annotation machinery. For the mobile-specific integration
suite, accessibility budget, and load tests, see the other files in this directory — this doc
covers the `CI` workflow itself.

## Jobs

| Job                     | Gate                                                                                                                                                       | Needs a database?     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `cross-tenant-security` | NFR-05 cross-tenant isolation probe                                                                                                                        | Yes (Postgres)        |
| `api-integration`       | API integration suite, ST-116/ST-071 probes, email/ERPNext webhook DB tests, auth+refresh-rotation benchmarks                                              | Yes (Postgres, Redis) |
| `database-migrations`   | Migrations apply cleanly, RLS coverage, `packages/db` tests, partition maintenance, seed integration                                                       | Yes (Postgres)        |
| `web-accessibility`     | ST-211 axe budget + keyboard-only walkthrough                                                                                                              | No                    |
| `mobile-api-client`     | Generated Dart client matches `openapi.json` (no drift) and reaches a live `/healthz`                                                                      | No                    |
| `mobile-unit-coverage`  | `flutter analyze` (report-only for now), Flutter unit+widget tests, ST-245 coverage gate                                                                   | No                    |
| `security-scan`         | Trivy filesystem scan (secrets + dependency CVEs), `dependency-review-action` on PRs                                                                       | No                    |
| `sast`                  | Semgrep SAST (`p/ci` ruleset), SARIF uploaded to code scanning                                                                                             | No                    |
| `quality`               | Affected-package lint/typecheck/build/test (Turbo), format check, permission-matrix drift, OpenAPI breaking-change check, perf benchmarks, Storybook build | No                    |
| `hooks`                 | Commitlint accepts conventional commits and rejects non-conforming ones                                                                                    | No                    |

`database-migrations`, `api-integration`, and `cross-tenant-security` each start their own
disposable Postgres/Redis via `db/compose.yml` rather than a `services:` block, because the
Postgres image needs `pg_stat_statements` preloaded via a container command — see those jobs'
own comments for why.

## Affected-only Turbo, and its actual cache story

`quality` is the one job that scales with repo size, so it's the one built to skip work:

1. **Filter.** `.github/scripts/resolve-affected-filter.sh` diffs against the PR's base commit (or
   the pre-push commit, on a push to `dev`) and emits a `turbo --filter=...[<ref>]` argument —
   changed packages plus everything that depends on them. If no usable base commit exists (e.g.
   the branch's first push), it emits nothing and Turbo falls back to running every package. This
   needs `fetch-depth: 0` on checkout so the base commit is present locally without an extra
   network fetch.
2. **Turbo's own content-addressed skip.** Independent of the filter above: even a package inside
   the affected set replays its cached output instead of re-running, if none of its declared
   inputs changed. This is what actually decides whether a task runs — the filter only decides
   which packages are considered at all.
3. **Cross-run persistence.** `actions/cache` restores `.turbo/cache` keyed on the commit SHA with
   a same-OS restore-key fallback, so step 2's cache hits survive between CI runs instead of
   starting cold every time. There is no remote/shared cache (no Vercel Remote Cache token
   configured) — this is a local, per-runner cache, so a `restore-keys` miss (e.g. the very first
   run after this change, or a cache eviction) still means a full run once, at full cost.

Net effect: a PR that only touches one package's `src/` should lint/typecheck/build/test that
package and its dependents, with everything untouched restored from cache — the combination the
<10 minute target depends on. A PR touching a widely-depended-on package (`@studafy/constants`,
`@studafy/shared-schemas`) legitimately re-runs a large slice of the graph; that's correct
behavior, not a caching failure.

The benchmarks, permission-matrix drift check, OpenAPI breaking-change check, and Storybook build
in `quality` are **not** filtered by affected-package status — they're either already
sub-second or are correctness gates that must hold regardless of which files changed.

## PR-line annotations

- **Lint + typecheck (`quality`):** `bunx turbo run lint check-types build ... --log-order=grouped`
  is piped through `.github/scripts/annotate-diagnostics.mjs`, which turns each ESLint/tsc
  diagnostic into a `::error`/`::warning` workflow command anchored to the real repo-root-relative
  file and line. This script exists because a plain GitHub problem matcher can't do the one thing
  that's actually hard here: both tools report paths relative to the _package_ directory Turbo runs
  them in, not the repo root the annotation needs — the script resolves that translation per task
  using each workspace package's own directory. `set -o pipefail` is what keeps the step's exit
  code Turbo's, not the annotator's.
- **Dependency changes (`security-scan`):** `actions/dependency-review-action` comments directly on
  the PR's manifest diff for newly introduced vulnerable or disallowed dependencies. PR-only — it
  has no meaning on a push, since it diffs two refs.
- **Semgrep (`sast`):** findings are uploaded as SARIF to GitHub code scanning. On a public repo
  this alone gets you inline PR annotations; **on a private repo, GitHub Advanced Security must be
  enabled for code-scanning alerts to appear inline on the PR diff** — without it, findings still
  show on the Security tab and the job still fails on an `ERROR`-severity match (`--error`), but
  they won't overlay the diff.
- **Not annotated, honestly:** unit test failures (`quality`'s `test` step, `api-integration`,
  `database-migrations`) and `flutter analyze` (`mobile-unit-coverage`). Test assertion failures
  don't reduce to a clean single file/line the way a lint or type error does, and building a
  correct annotator for `flutter analyze`'s output was out of scope here. Test failures still fail
  their job and print the tool's own output to the step log.
- **`flutter analyze` is report-only for now (`mobile-unit-coverage`):** the job is new in the
  branch that added it, and that branch changes only CI YAML/scripts — so every finding it reports
  is a pre-existing `apps/mobile` issue, not a regression. `dart analyze` has no `--baseline-commit`
  equivalent to scope it to the PR diff the way the `sast` job scopes Semgrep, so a hard gate here
  would block unrelated PRs on that pre-existing backlog. The step runs and its findings surface as
  a `::warning::`; it does not red the job. Restore the hard gate (exit 1 in the "Report analyze
  findings" step) once the backlog is cleared in its own pass.

## Coverage

- **JS/TS (`quality`):** `bunx turbo run test ... -- --coverage --coverage-reporter=lcov` (a
  separate invocation from lint/check-types/build, since `--` forwards flags to every underlying
  script and lint/tsc don't take `--coverage`). `turbo.json`'s `test` task declares
  `coverage/**` as an output so a cache hit restores the lcov file instead of leaving it stale.
  Uploaded as the `coverage-report` artifact (`apps/*/coverage/lcov.info`,
  `packages/*/coverage/lcov.info`). No coverage _gate_ (minimum threshold) exists yet for JS/TS —
  only the mobile suite has one (ST-245). Known cosmetic side effect: because `test`'s `outputs`
  is now non-empty, a plain `turbo run test` (no `--coverage`, as `ci:local` and every other job
  that runs the test task does) prints a `no output files found for task X#test` warning per
  package — expected, since that invocation genuinely writes no `coverage/`, and harmless (it's a
  warning, not a failure).
- **Flutter (`mobile-unit-coverage`):** `flutter test --coverage` → `dart run
scripts/check_coverage.dart` (the actual gate) → uploaded as the `mobile-coverage-report`
  artifact.
- Neither is wired to an external coverage service (Codecov et al.) — there's no such account/token
  for this repo today. Artifacts are the honest baseline; swapping to a hosted service later is
  additive (one upload step, one secret), not a redesign.

## Security scanning

- **Secrets + dependency CVEs (`security-scan`):** one `aquasecurity/trivy-action` filesystem scan,
  `scanners: secret,vuln`, pinned to the same `trivy-action@v0.36.0` / trivy `v0.72.0` that
  `containers.yml` and `terraform.yml` already use — `.trivyignore`'s header documents that pin as
  the project's baseline. (This job used to run `trivy-action@master` for secrets only; that
  floating tag drifted from the documented baseline on trivy's release schedule rather than the
  codebase's, which is why it's pinned now.) `ignore-unfixed: true` and `severity: CRITICAL,HIGH`
  match the same convention `containers.yml` uses for image scans.
- **Dependency-diff review (`security-scan`, PRs only):** `actions/dependency-review-action`,
  `fail-on-severity: high` — catches a newly _introduced_ vulnerable dependency in the PR's own
  diff, which a full-tree scan reports but doesn't specifically call out as "new in this PR."
  Currently `continue-on-error: true`: the action can't run until GitHub's **Dependency Graph** is
  enabled for the repo (Settings → Security & analysis), which on a private repo needs GitHub
  Advanced Security. Until then it reports but doesn't gate; the trivy step above still fails the
  job on a HIGH/CRITICAL dependency CVE. Remove that line once Dependency Graph is on.
- **SAST (`sast`):** Semgrep's `p/ci` ruleset (its own recommended default: broad OWASP-Top-10-style
  coverage without the noisier experimental rules), run via the official `semgrep/semgrep` image.
  `--error` is required for `semgrep scan` to exit non-zero on a finding — without it, the command
  always exits 0 regardless of what it finds.

None of this replaces the container-image scans in `containers.yml` — those cover the built
image's OS packages; this workflow's `security-scan`/`sast` cover source and first-party
dependencies before an image is ever built.

## Required status checks

Not configured by this change — GitHub branch protection lives in repository settings, not in a
workflow file, and this session had no authenticated `gh`/API access to the repo to set it.
**A repo admin still needs to mark these as required** (Settings → Branches → branch protection
rule for `main`/`dev` → Require status checks to pass):

```
CI / cross-tenant-security
CI / api-integration
CI / database-migrations
CI / quality
CI / security-scan
CI / sast
CI / hooks
```

`web-accessibility`, `mobile-api-client`, and `mobile-unit-coverage` are deliberately left off that
list as _recommended-but-optional_ required checks — the team should decide whether a PR that
doesn't touch `apps/web`/`apps/mobile` should still block on them. Everything above gates
correctness or security broadly enough that it should never be skippable.

## Running the equivalent checks locally

```sh
bun run format:check
bunx turbo run lint check-types test build --filter=!@studafy/mobile   # full run, no affected filter
bun run --cwd apps/mobile flutter analyze          # after: bun run --cwd apps/mobile client:generate
bun run --cwd apps/mobile test:coverage && bun run --cwd apps/mobile coverage:check
```

`bun run ci:local` runs the non-database subset of this in one command (see `package.json`);
`ci:local:db` additionally spins up Postgres for the database-backed suites.
